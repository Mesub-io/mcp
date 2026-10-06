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
    CheckLane,
    DEFAULT_LIMITS,
    KnownTokens,
    REFUSED_TOKEN_TTL_MS,
    REFUSED_TOKENS_MAX,
    RefusedTokens,
    WINDOW_MS,
    WindowLimiter,
    type Limits,
    type Pass,
    type Taken,
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
 * no good answer is ever taken for the next request: a connection revoked in
 * the dashboard is refused on the very next one. The answer must also name
 * this server as the token's audience and the configured issuer as its issuer.
 *
 * What the limits here may and may not do is in src/rate-limit.ts: none of
 * them refuses a caller for what another one sent.
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
const RETRY_SHED = 1;
const MAX_RETRY_UNAVAILABLE = 60;

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
const ADDRESS = 'mesub.io/address';

/** The caller the seam vouched for, read back from what it handed the SDK. */
export function callerOf(authInfo: AuthInfo | undefined): Caller | undefined {
    const caller = authInfo?.extra?.[CALLER];
    return isCaller(caller) ? caller : undefined;
}

/** The address the request counted as, for the trace a tool call leaves. */
export function addressOf(authInfo: AuthInfo | undefined): string {
    const address = authInfo?.extra?.[ADDRESS];
    return typeof address === 'string' ? address : 'unknown';
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

const MAX_LABEL_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// A URL of nothing but a scheme, a host, a port and an ordinary path.
const PLAIN_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

/**
 * A URL the API answered with (an issuer, an audience), fit to be written in
 * a log line: as it came when it is a plain URL, in its normalised form when
 * it is an odd one, and as a label when it is not a URL at all. What the API
 * answers is never written raw.
 */
export function loggableUrl(value: string): string {
    if (value.length <= MAX_LABEL_LENGTH && PLAIN_URL.test(value)) return value;
    if (URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)) {
        return new URL(value).href.slice(0, MAX_LABEL_LENGTH);
    }
    return `[not a URL, ${value.length} characters]`;
}

/** A name somebody else wrote, cut short and without what could break a line. */
export function loggableName(value: string): string {
    return value.replace(CONTROL, ' ').slice(0, 100);
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
    /** Tests only: a shorter wait for the API to vouch for a token. */
    verifyTimeoutMs?: number | undefined;
    /** Tests only: a shorter wait for the API to answer a tool. */
    apiTimeoutMs?: number | undefined;
}

export interface Authenticator {
    /** Where the protected resource metadata is, as the challenge names it. */
    resourceMetadataUrl: string;
    /** The paths the metadata is served at: the one of the MCP endpoint, and the root. */
    metadataPaths: string[];
    /** The protected resource metadata, for a request to one of `metadataPaths`. */
    metadata: (request: Request) => Response;
    /** The address a request counts as. `peer` is the address of the socket it came on. */
    addressOf: (request: Request, peer: string | undefined) => string;
    /**
     * Writes a line about a request this server refused, a bounded number of
     * times a minute for one address. Past that, the lines stop: a flood of
     * refusals must not become a flood of lines. No request is ever refused
     * for it.
     */
    note: (
        address: string,
        level: 'info' | 'warn' | 'error',
        message: string,
        fields: Record<string, unknown>,
    ) => void;
    /**
     * Who is calling, or the response that refuses them. `peer` is the
     * address of the socket the request came on.
     */
    authenticate: (request: Request, peer: string | undefined) => Promise<AuthInfo | Response>;
    /** The Mesub API as the holder of a token the seam let through. */
    mesubFor: (token: string) => MesubClient;
}

/** What asking the API about a token came to. */
type Verdict =
    | { kind: 'accepted'; whoami: AgentWhoami }
    | { kind: 'refused' }
    | { kind: 'left' }
    | { kind: 'unknown'; response: Response };

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
        new WindowLimiter({ limit, windowMs: WINDOW_MS, maxKeys: limits.maxKeys, now });
    // See src/rate-limit.ts for what each is, and for what none of them may do.
    const connections = limiter(limits.perConnection);
    const lines = limiter(limits.logLinesPerAddress);
    const refused = new RefusedTokens({
        ttlMs: REFUSED_TOKEN_TTL_MS,
        max: Math.min(REFUSED_TOKENS_MAX, limits.maxKeys),
        now,
    });
    const known = new KnownTokens({ max: limits.maxKeys, now });
    const lane = new CheckLane({
        perAddress: limits.checksPerAddress,
        total: limits.checksTotal,
        waitingPerAddress: limits.waitingPerAddress,
        waitingTotal: limits.waitingTotal,
        maxWaitMs: limits.maxWaitMs,
    });

    // Said once a minute per table: a table that is full dropped keys that
    // still counted. Whoever they were, their counters started afresh.
    const full = limiter(1);
    const dropped = new Map<WindowLimiter, number>();
    const watch = (table: string, counted: WindowLimiter) => {
        const before = dropped.get(counted) ?? 0;
        if (counted.dropped === before) return;
        dropped.set(counted, counted.dropped);
        if (full.take(table).ok) {
            logger.warn('limiter full', {
                table,
                keys: counted.size,
                hint: 'More keys than this table holds: the least recently used were dropped and count from zero again. Nobody is refused for it.',
            });
        }
    };

    const mesubFor = (token: string) =>
        new MesubClient({
            baseUrl: config.mesubApiUrl,
            token,
            serviceSecret: config.serviceSecret,
            ...(dependencies.fetch && { fetch: dependencies.fetch }),
            ...(dependencies.apiTimeoutMs !== undefined && {
                timeoutMs: dependencies.apiTimeoutMs,
            }),
        });

    const note: Authenticator['note'] = (address, level, message, fields) => {
        const taken = lines.take(address);
        watch('log lines', lines);
        if (taken.ok) return logger[level](message, { ...fields, address });
        if (taken.first) {
            logger.warn('log lines held back', {
                address,
                hint: 'This address is refused more often than is worth a line each. Its requests are answered as before.',
            });
        }
    };

    /** 401, the same for every request without a valid token: which it was is in the logs. */
    const challenge = (address: string, reason: string, fields: Record<string, unknown> = {}) => {
        note(address, 'info', 'request refused', { reason, ...fields });
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

    /** 429: this connection, and nobody else, is past its own rate. */
    const overRate = (connectionId: string, taken: Extract<Taken, { ok: false }>): Response => {
        // Once per window: a flood must not become a flood of lines.
        if (taken.first) logger.warn('rate limited', { limit: 'connection', connectionId });
        return Response.json(
            new OAuthError(
                OAuthErrorCode.TooManyRequests,
                'Too many requests for this connection. Try again later.',
            ).toResponseObject(),
            { status: 429, headers: { 'Retry-After': String(taken.retryAfterSeconds) } },
        );
    };

    /** Why the API could not vouch for a token, and what the caller is told. */
    const failed = (error: MesubApiError): Response => {
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
            // The API is short of room for this check. That is a capacity
            // problem between it and us, not a rate the caller went over:
            // never a 429 of ours, and nothing is remembered against the token.
            logger.error('cannot check access tokens', {
                reason: 'api_rate_limited',
                hint: 'The Mesub API answered 429 to a token check. Callers are told to try again; none is refused for good.',
            });
            return unavailable(
                clamp(retryAfterSeconds ?? RETRY_UNAVAILABLE, MAX_RETRY_UNAVAILABLE),
            );
        }
        if (status === null || status === 503) {
            logger.warn('cannot check access tokens', { reason: 'api_unavailable', status });
            return unavailable(
                clamp(retryAfterSeconds ?? RETRY_UNAVAILABLE, MAX_RETRY_UNAVAILABLE),
            );
        }
        // A 200 that cannot be read, a 401 that is not one of the two the API
        // documents, anything else: not a verdict on the token. `code` is one
        // the API client took for a short plain word, or made from the status.
        logger.error('cannot check access tokens', { reason: 'unexpected_answer', status, code });
        return unavailable(RETRY_UNAVAILABLE);
    };

    /** Asks the API. Remembers a refusal, and nothing else. */
    const ask = async (request: Request, token: string, address: string): Promise<Verdict> => {
        try {
            const whoami = await mesubFor(token).whoami({
                signal: request.signal,
                timeoutMs: verifyTimeoutMs,
            });
            return { kind: 'accepted', whoami };
        } catch (error) {
            if (!(error instanceof MesubApiError)) throw error;
            if (request.signal.aborted) {
                // Nobody is there to answer, and the API did nothing wrong.
                logger.debug('caller left', { address });
                return { kind: 'left' };
            }
            if (error.status === 401 && error.code === 'invalid_agent_token') {
                refused.add(token);
                known.delete(token);
                return { kind: 'refused' };
            }
            return { kind: 'unknown', response: failed(error) };
        }
    };

    /** 499 by convention: the caller hung up, nobody reads this. */
    const gone = () => new Response(null, { status: 499 });

    const authenticate = async (
        request: Request,
        peer: string | undefined,
    ): Promise<AuthInfo | Response> => {
        const address = clientAddress(peer, request.headers, config.clientAddress);

        // A token is only ever read from the Authorization header, never from the URL.
        const header = request.headers.get('authorization');
        const presented = header === null ? undefined : BEARER.exec(header)?.[1];
        const token =
            presented !== undefined && ACCESS_TOKEN.test(presented) ? presented : undefined;

        // Always answered, however many came before: the 401 costs nothing,
        // and a client that has no token yet needs it to find where to get one.
        if (token === undefined) {
            return challenge(address, header === null ? 'no_token' : 'malformed_token');
        }
        // The same for a token the API just refused: its holder must learn to refresh.
        if (refused.has(token)) return challenge(address, 'refused_token_cached');

        // A token the API accepted here before: its connection's own rate is
        // known before the API is asked, and it does not wait behind strangers.
        // It is still asked about, every time.
        const knownConnection = known.connectionOf(token);
        let place: Taken | undefined;
        let pass: Pass | undefined;
        if (knownConnection !== undefined) {
            place = connections.take(knownConnection);
            watch('connections', connections);
            if (!place.ok) return overRate(knownConnection, place);
        } else {
            // A token nobody vouched for yet: one of a few checks at a time,
            // for this address and for the instance. This is the whole of what
            // a flood of made-up tokens can cost the API.
            pass = await lane.enter(address, token, request.signal);
            if (request.signal.aborted) {
                pass?.leave();
                return gone();
            }
            if (pass === undefined) {
                note(address, 'warn', 'checks shed', {
                    hint: 'More tokens this instance has never seen than it checks at a time. The caller is told to come back in a moment.',
                });
                return unavailable(RETRY_SHED);
            }
            // Refused while this request waited: no need to ask again.
            if (refused.has(token)) {
                pass.leave();
                return challenge(address, 'refused_token_cached');
            }
        }

        let verdict: Verdict;
        try {
            verdict = await ask(request, token, address);
        } finally {
            pass?.leave();
        }

        if (verdict.kind !== 'accepted') {
            // No verdict, or a dead token: the connection's place was not used.
            if (place?.ok) place.refund();
            if (verdict.kind === 'left') return gone();
            if (verdict.kind === 'refused') return challenge(address, 'refused_token');
            return verdict.response;
        }

        const { whoami } = verdict;
        const mismatch = (reason: string, expected: string, received: string, hint: string) => {
            if (place?.ok) place.refund();
            // A fault in how this server and the API are set up, never the
            // token's: 503, nothing remembered, and both values for whoever
            // has to fix it. The received one is never written raw.
            logger.error('cannot check access tokens', {
                reason,
                expected,
                received: loggableUrl(received),
                hint,
            });
            return unavailable(RETRY_MISCONFIGURED);
        };
        if (whoami.issuer !== config.issuerUrl) {
            return mismatch(
                'issuer_mismatch',
                config.issuerUrl,
                whoami.issuer,
                'MESUB_ISSUER_URL is not the issuer the Mesub API at MESUB_API_URL names (its PUBLIC_API_URL).',
            );
        }
        if (whoami.audience !== config.resourceUrl) {
            return mismatch(
                'audience_mismatch',
                config.resourceUrl,
                whoami.audience,
                "The Mesub API issues tokens for another resource: its MCP_RESOURCE_URL must be this server's <MCP_PUBLIC_URL>/mcp, character for character.",
            );
        }
        if (whoami.expires_at * 1000 <= now()) {
            if (place?.ok) place.refund();
            return challenge(address, 'expired_token', { connectionId: whoami.connection_id });
        }

        // From now on the token is one this instance has seen accepted.
        known.add(token, whoami.connection_id, whoami.expires_at * 1000);
        lane.promote(token);

        if (place === undefined || whoami.connection_id !== knownConnection) {
            if (place?.ok) place.refund();
            place = connections.take(whoami.connection_id);
            watch('connections', connections);
            if (!place.ok) return overRate(whoami.connection_id, place);
        }

        // The trace a token leaves: who, for which project, from where.
        logger.info('request let in', {
            connectionId: whoami.connection_id,
            projectId: whoami.project.id,
            address,
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
            extra: { [CALLER]: caller, [ADDRESS]: address },
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
        addressOf: (request, peer) => clientAddress(peer, request.headers, config.clientAddress),
        note,
        authenticate,
        mesubFor,
    };
}

function clamp(seconds: number, max: number): number {
    return Math.min(Math.max(1, Math.ceil(seconds)), max);
}
