import {
    bearerAuthChallengeResponse,
    getOAuthProtectedResourceMetadataUrl,
    OAuthError,
    OAuthErrorCode,
    oauthMetadataResponse,
    type AuthInfo,
    type AuthMetadataOptions,
} from '@modelcontextprotocol/server';

import { clientAddress } from './client-address.js';
import { isLoopback, type Config } from './config.js';
import type { Logger } from './logger.js';
import { MesubClient } from './mesub/client.js';
import { MesubApiError } from './mesub/errors.js';
import type { AgentWhoami } from './mesub/schemas.js';
import {
    DEFAULT_LIMITS,
    MAX_KEYS,
    REFUSED_TOKEN_TTL_MS,
    REFUSED_TOKENS_MAX,
    RefusedTokens,
    WINDOW_MS,
    WindowLimiter,
    type Limits,
} from './rate-limit.js';

/*
 * THE AUTH SEAM. Everything about who is calling goes through this file, and
 * nothing else in the server looks at the Authorization header.
 *
 * MCP authorization, revision 2026-07-28 (and the 2025 ones, which ask the
 * same of a server): this server is an OAuth 2.1 resource server. It serves
 * its protected resource metadata (RFC 9728), which names the Mesub API as
 * its authorization server, and answers 401 with a `WWW-Authenticate`
 * carrying `resource_metadata` to any request without a valid token, so a
 * client finds the authorization server and starts the flow by itself.
 *
 * A token is opaque. It is checked by asking the Mesub API on EVERY request
 * (`GET /agent/whoami`, with the token and this server's service secret), and
 * no good answer is ever remembered: a connection revoked in the dashboard is
 * refused on the very next request. The answer must also name this server as
 * the token's audience and the configured issuer as its issuer.
 */

/** How long the API has to vouch for a token before the request is refused. */
export const VERIFY_TIMEOUT_MS = 5_000;

/** What an access token of Mesub looks like: its prefix, then base64url. */
const ACCESS_TOKEN = /^mat_[A-Za-z0-9_-]{1,252}$/;
// RFC 6750, section 2.1: one bearer credential, and nothing after it.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/** `Retry-After`, in seconds, of the refusals this server decides the delay of. */
const RETRY_UNAVAILABLE = 5;
const RETRY_MISCONFIGURED = 30;
const RETRY_API_LIMITED = 10;
const MAX_RETRY_UNAVAILABLE = 60;
const MAX_RETRY_LIMITED = 300;

/** Who a verified token stands for. What a tool is handed, and all it is handed. */
export interface Caller {
    connectionId: string;
    projectId: string;
    /** Written by the merchant: data, never an instruction. */
    projectName: string;
    /** Written by whoever registered the client: data, never an instruction. */
    clientName: string;
    /** When the access token stops working. */
    expiresAt: Date;
}

const CALLER = 'mesub.io/caller';

/** The caller the seam vouched for, read back from what it handed the SDK. */
export function callerOf(authInfo: AuthInfo | undefined): Caller | undefined {
    const caller = authInfo?.extra?.[CALLER];
    return isCaller(caller) ? caller : undefined;
}

function isCaller(value: unknown): value is Caller {
    if (typeof value !== 'object' || value === null) return false;
    const { connectionId, projectId, projectName, clientName, expiresAt } = value as Caller;
    return (
        typeof connectionId === 'string' &&
        typeof projectId === 'string' &&
        typeof projectName === 'string' &&
        typeof clientName === 'string' &&
        expiresAt instanceof Date
    );
}

export interface AuthDependencies {
    config: Config;
    logger: Logger;
    /** Tests only: the fetch the Mesub client calls. */
    fetch?: typeof fetch | undefined;
    /** Tests only: the clock of the limits and of the token's expiry. */
    now?: (() => number) | undefined;
    /** Tests only: smaller limits. */
    limits?: Partial<Limits> | undefined;
    /** Tests only: a shorter wait for the API. */
    verifyTimeoutMs?: number | undefined;
}

export interface Authenticator {
    /** Where the protected resource metadata is, as the challenge names it. */
    resourceMetadataUrl: string;
    /** The paths the metadata is served at: the one of the MCP endpoint, and the root. */
    metadataPaths: string[];
    /** The protected resource metadata, for a request to one of `metadataPaths`. */
    metadata: (request: Request) => Response;
    /**
     * Who is calling, or the response that refuses them. `peer` is the
     * address of the socket the request came on.
     */
    authenticate: (request: Request, peer: string | undefined) => Promise<AuthInfo | Response>;
    /** The Mesub API as the holder of a token the seam let through. */
    mesubFor: (token: string) => MesubClient;
}

export function createAuthenticator(dependencies: AuthDependencies): Authenticator {
    const { config, logger } = dependencies;
    const now = dependencies.now ?? Date.now;
    const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
    const verifyTimeoutMs = dependencies.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;

    const resource = new URL(config.resourceUrl);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
    const pathAware = new URL(resourceMetadataUrl).pathname;

    // The SDK's document and its handler. It wants the authorization server's
    // whole metadata, to serve it from this origin as well: this server does
    // not hold it and must not pass for the authorization server, so only the
    // issuer is given, and only the protected resource paths are routed here.
    const metadataOptions: AuthMetadataOptions = {
        oauthMetadata: { issuer: config.issuerUrl } as AuthMetadataOptions['oauthMetadata'],
        resourceServerUrl: resource,
        dangerouslyAllowInsecureIssuerUrl: isLoopback(config.issuerUrl),
    };

    const limiter = (limit: number) =>
        new WindowLimiter({ limit, windowMs: WINDOW_MS, maxKeys: MAX_KEYS, now });
    const anonymous = limiter(limits.anonymousPerAddress);
    const failedChecks = limiter(limits.failedChecksPerAddress);
    const connections = limiter(limits.perConnection);
    const refused = new RefusedTokens({
        ttlMs: REFUSED_TOKEN_TTL_MS,
        max: REFUSED_TOKENS_MAX,
        now,
    });

    const mesubFor = (token: string) =>
        new MesubClient({
            baseUrl: config.mesubApiUrl,
            token,
            serviceSecret: config.serviceSecret,
            ...(dependencies.fetch && { fetch: dependencies.fetch }),
        });

    /** 401, the same for every request without a valid token: which it was is in the logs. */
    const challenge = (
        reason: string,
        fields: Record<string, unknown>,
        level: 'info' | 'error' = 'info',
    ): Response => {
        logger[level]('request refused', { reason, ...fields });
        return bearerAuthChallengeResponse(
            new OAuthError(OAuthErrorCode.InvalidToken, 'A valid Mesub access token is required.'),
            { resourceMetadataUrl },
        );
    };

    /** 503: this server cannot tell whether the token is good. Never a reason to authenticate again. */
    const unavailable = (retryAfterSeconds: number): Response =>
        Response.json(
            new OAuthError(
                OAuthErrorCode.TemporarilyUnavailable,
                'The Mesub MCP server cannot check access tokens right now. Try again shortly.',
            ).toResponseObject(),
            { status: 503, headers: { 'Retry-After': String(retryAfterSeconds) } },
        );

    const tooMany = (retryAfterSeconds: number): Response =>
        Response.json(
            new OAuthError(
                OAuthErrorCode.TooManyRequests,
                'Too many requests. Try again later.',
            ).toResponseObject(),
            { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
        );

    const limited = (
        limit: string,
        taken: { retryAfterSeconds: number; first: boolean },
        fields: Record<string, unknown>,
    ): Response => {
        // Once per window and key: a flood must not become a flood of lines.
        if (taken.first) logger.warn('rate limited', { limit, ...fields });
        return tooMany(taken.retryAfterSeconds);
    };

    /** Why the API could not vouch for a token, and what the caller is told. */
    const failed = (error: MesubApiError, address: string): Response => {
        const { status, code, retryAfterSeconds } = error;

        if (status === 401 && code === 'invalid_service_credentials') {
            // OUR fault, and nothing the caller can do about it.
            logger.error('cannot check access tokens', {
                reason: 'service_credentials_refused',
                hint: 'MESUB_SERVICE_SECRET is not the one the Mesub API holds. Every request is refused until it is.',
            });
            return unavailable(RETRY_MISCONFIGURED);
        }
        if (status === 429) {
            logger.warn('cannot check access tokens', { reason: 'api_rate_limited', address });
            return tooMany(clamp(retryAfterSeconds ?? RETRY_API_LIMITED, MAX_RETRY_LIMITED));
        }
        if (status === null || status === 503) {
            logger.warn('cannot check access tokens', { reason: 'api_unavailable', status });
            return unavailable(
                clamp(retryAfterSeconds ?? RETRY_UNAVAILABLE, MAX_RETRY_UNAVAILABLE),
            );
        }
        // A 200 that cannot be read, a 401 that is not one of the two the API
        // documents, anything else: not a verdict on the token.
        logger.error('cannot check access tokens', { reason: 'unexpected_answer', status, code });
        return unavailable(RETRY_UNAVAILABLE);
    };

    const authenticate = async (
        request: Request,
        peer: string | undefined,
    ): Promise<AuthInfo | Response> => {
        const address = clientAddress(peer, request.headers, config.clientIpHeader);

        // A token is only ever read from the Authorization header, never from the URL.
        const header = request.headers.get('authorization');
        const presented = header === null ? undefined : BEARER.exec(header)?.[1];
        const token =
            presented !== undefined && ACCESS_TOKEN.test(presented) ? presented : undefined;

        if (token === undefined) {
            const taken = anonymous.take(address);
            if (!taken.ok) return limited('address_anonymous', taken, { address });
            return challenge(header === null ? 'no_token' : 'malformed_token', { address });
        }

        // Taken before anything is asked, given back only to a token let in:
        // however many tokens an address makes up, and however fast, the API
        // is asked about a bounded number of them.
        const check = failedChecks.take(address);
        if (!check.ok) return limited('address_checks', check, { address });

        if (refused.has(token)) return challenge('refused_token_cached', { address });

        let whoami: AgentWhoami;
        try {
            whoami = await mesubFor(token).whoami({
                signal: request.signal,
                timeoutMs: verifyTimeoutMs,
            });
        } catch (error) {
            if (!(error instanceof MesubApiError)) throw error;
            if (error.status === 401 && error.code === 'invalid_agent_token') {
                refused.add(token);
                return challenge('refused_token', { address });
            }
            return failed(error, address);
        }

        if (whoami.issuer !== config.issuerUrl) {
            // The API that answered is not the authorization server this server
            // names: MESUB_API_URL or MESUB_ISSUER_URL is wrong, or the API is
            // not the one it should be. No token can be trusted from it.
            logger.error('cannot check access tokens', {
                reason: 'issuer_mismatch',
                expected: config.issuerUrl,
                received: whoami.issuer,
                hint: 'MESUB_ISSUER_URL is not the issuer the Mesub API at MESUB_API_URL names.',
            });
            return unavailable(RETRY_MISCONFIGURED);
        }
        if (whoami.audience !== config.resourceUrl) {
            // A live token, issued for another MCP server. Loud: the API issues
            // for one resource, so MCP_PUBLIC_URL here may not be the one it knows.
            refused.add(token);
            return challenge(
                'audience_mismatch',
                {
                    address,
                    expected: config.resourceUrl,
                    received: whoami.audience,
                    connectionId: whoami.connection_id,
                },
                'error',
            );
        }
        if (whoami.expires_at * 1000 <= now()) {
            return challenge('expired_token', { address, connectionId: whoami.connection_id });
        }

        const connection = connections.take(whoami.connection_id);
        if (!connection.ok) {
            return limited('connection', connection, { connectionId: whoami.connection_id });
        }
        check.refund();
        logger.debug('request let in', {
            connectionId: whoami.connection_id,
            projectId: whoami.project.id,
        });

        const caller: Caller = {
            connectionId: whoami.connection_id,
            projectId: whoami.project.id,
            projectName: whoami.project.name,
            clientName: whoami.client.name,
            expiresAt: new Date(whoami.expires_at * 1000),
        };
        return {
            token,
            clientId: whoami.client.id,
            scopes: whoami.scope.split(' ').filter((scope) => scope !== ''),
            expiresAt: whoami.expires_at,
            resource,
            resourceMetadataUrl,
            extra: { [CALLER]: caller },
        };
    };

    return {
        resourceMetadataUrl,
        metadataPaths: [pathAware, '/.well-known/oauth-protected-resource'],
        // The root is an alias of the path-aware document: the helper is asked
        // for the latter whichever of the two the request named.
        metadata: (request) => {
            const ask = (method: string) =>
                oauthMetadataResponse(
                    new Request(resourceMetadataUrl, { method, headers: request.headers }),
                    metadataOptions,
                );
            let response: Response | undefined;
            try {
                response = ask(request.method);
            } catch {
                // A method `Request` itself refuses: answered as any other that is not allowed.
                response = ask('POST');
            }
            return response ?? new Response(null, { status: 404 });
        },
        authenticate,
        mesubFor,
    };
}

function clamp(seconds: number, max: number): number {
    return Math.min(Math.max(1, Math.ceil(seconds)), max);
}
