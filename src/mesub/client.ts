import type * as z from 'zod';

import { revealSecret, type Secret } from '../secret.js';
import { VERSION } from '../version.js';
import { MesubApiError, codeForStatus } from './errors.js';
import { isLink } from './link.js';
import {
    agentAccessListSchema,
    agentAccessSchema,
    agentEventDaysSchema,
    agentEventLinesSchema,
    agentOverviewSchema,
    agentPlanDetailSchema,
    agentPlanSchema,
    agentPlansSchema,
    agentProjectSchema,
    agentSubscriptionPageSchema,
    agentSubscriptionSchema,
    agentUpcomingSchema,
    agentWhoamiSchema,
    apiHealthSchema,
    nothingSchema,
    preparedPlanSchema,
    renamedProjectSchema,
    webhookDeliveryPageSchema,
    webhookDeliverySchema,
    webhookEndpointSchema,
    webhookEndpointsSchema,
    webhookEndpointWithSecretSchema,
    webhookSecretSchema,
    type AccessAnswer,
    type AccessList,
    type AgentEventDays,
    type AgentEventLine,
    type AgentListedPlan,
    type AgentOverview,
    type AgentPlan,
    type AgentPlanDetail,
    type AgentProject,
    type AgentSubscription,
    type AgentSubscriptionPage,
    type AgentUpcomingLine,
    type AgentWhoami,
    type ApiHealth,
    type PreparedPlan,
    type ServedProject,
    type WebhookDelivery,
    type WebhookDeliveryPage,
    type WebhookEndpoint,
    type WebhookEndpointWithSecret,
} from './schemas.js';

/**
 * The version of the Mesub API this server was written against, sent in the
 * `Mesub-Version` header of every call, as `@mesub/node` does.
 */
export const API_VERSION = '2026-10-02';

/** The header this server proves itself in. The agent's token is the bearer. */
const SERVICE_SECRET_HEADER = 'X-Mesub-Service-Secret';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 500;
/** The longest answer read. The API's are a few kilobytes: past this, something else is talking. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REDACTED = '[redacted]';

export interface MesubClientOptions {
    /** Without a trailing slash. */
    baseUrl: string;
    /** The agent's access token, as it came. Worth nothing to the API without the service secret. */
    token: string;
    /** This server's own credential. Worth nothing to the API without an agent's token. */
    serviceSecret: Secret;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined;

/**
 * Who a call is made as. There is no third way, and no default: a call
 * carries both credentials or neither, and a method says which.
 */
type Credentials = 'agent' | 'none';

interface CallOptions<T> {
    /** `agent`: the agent's token AND the service secret. `none`: a public route. */
    as: Credentials;
    query?: Record<string, QueryValue>;
    body?: unknown;
    /** What a 2xx must look like. */
    schema: z.ZodType<T>;
    /** The tool call's own signal: a caller that leaves stops the call. */
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
}

// One path segment after another, of unreserved characters and percent
// escapes. No query, no fragment, no backslash, nothing a header could end on.
const PLAIN_PATH = /^(?:\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+)+$/;
// An escape that hides a separator from this check and shows it to whoever
// decodes next: a slash, a backslash, a dot, a percent sign, a control character.
const ENCODED_SEPARATOR = /%(?:2f|5c|2e|25|[01][0-9a-f]|7f)/i;
const MAX_SEGMENT_LENGTH = 200;
// What an id never holds, and a path must never be built from.
// eslint-disable-next-line no-control-regex
const NOT_AN_ID = /[/\\%\u0000-\u001f\u007f]|\.\./;

/**
 * A value read from a caller (an id, a name) as one segment of a path. Every
 * method that puts one in a path goes through here, so no argument of a tool
 * can reach another route, another host or the query. A value holding a
 * separator is refused, not encoded: an id is not a path.
 */
export function pathSegment(value: string): string {
    if (
        value === '' ||
        value === '.' ||
        value.length > MAX_SEGMENT_LENGTH ||
        NOT_AN_ID.test(value)
    ) {
        // Never the value: it came from a caller.
        throw new Error('Refused a path segment that is not a plain one.');
    }
    return encodeURIComponent(value);
}

/**
 * The URL of one route of the API. Refuses anything but a plain path under
 * the base URL: a query goes through `query`, where every value is encoded.
 */
export function apiUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): URL {
    const plain =
        PLAIN_PATH.test(path) &&
        !ENCODED_SEPARATOR.test(path) &&
        !path.split('/').some((part) => part === '.' || part === '..');
    // Never `new URL(path, base)`, which drops a path the base carries.
    const url = plain && URL.canParse(baseUrl + path) ? new URL(baseUrl + path) : undefined;
    const base = new URL(baseUrl);

    if (
        url === undefined ||
        url.origin !== base.origin ||
        url.pathname !== base.pathname.replace(/\/+$/, '') + path ||
        url.search !== '' ||
        url.hash !== '' ||
        url.username !== '' ||
        url.password !== ''
    ) {
        // Never the path: it may hold what a caller wrote.
        throw new Error('Refused to call a path that is not a plain one.');
    }

    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
}

/** Who `GET /agent/access` is asked about: exactly one of the three. */
export type AccessQuery = {
    wallet?: string | undefined;
    external_id?: string | undefined;
    email?: string | undefined;
    attempts?: boolean | undefined;
};

/** What narrows `GET /agent/events`. */
export type EventsQuery = {
    plan?: string | undefined;
    group?: string | undefined;
    q?: string | undefined;
    by?: string | undefined;
};

/**
 * The Mesub HTTP API, as this server acting for one agent. It is the only
 * place a credential is put on a request, and it puts both or none: the
 * agent's token never leaves alone, nor does the service secret. Neither is
 * ever in a URL, an error or a log: they sit in private fields nothing prints,
 * and go out in two headers, to the configured API and nowhere it redirects.
 *
 * One method per route a tool needs, nothing more. No retry here: a tool
 * reports the failure and the agent decides.
 */
export class MesubClient {
    readonly #baseUrl: string;
    readonly #token: string;
    readonly #serviceSecret: Secret;
    readonly #fetch: typeof fetch;
    readonly #timeoutMs: number;

    constructor(options: MesubClientOptions) {
        this.#baseUrl = options.baseUrl;
        this.#token = options.token;
        this.#serviceSecret = options.serviceSecret;
        this.#fetch = options.fetch ?? fetch;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /** `GET /health`: whether the API is up. A public route: no credential is sent. */
    health(signal?: AbortSignal): Promise<ApiHealth> {
        return this.#call('GET', '/health', { as: 'none', schema: apiHealthSchema, signal });
    }

    /**
     * `GET /agent/whoami`: the connection the token stands for, read from the
     * database on every call. 401 `invalid_agent_token` when the token is not
     * good, 401 `invalid_service_credentials` when this server's secret is not.
     */
    whoami(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AgentWhoami> {
        return this.#call('GET', '/agent/whoami', {
            as: 'agent',
            schema: agentWhoamiSchema,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        });
    }

    // The routes under /agent, one method each. Every one is made as the
    // agent: the project is the token's, and no method takes its id.

    /** `GET /agent/project`. */
    project(signal?: AbortSignal): Promise<AgentProject> {
        return this.#call('GET', '/agent/project', {
            as: 'agent',
            schema: agentProjectSchema,
            signal,
        });
    }

    /** `PATCH /agent/project`: the name, and nothing else. */
    renameProject(name: string, signal?: AbortSignal): Promise<ServedProject> {
        return this.#call('PATCH', '/agent/project', {
            as: 'agent',
            body: { name },
            schema: renamedProjectSchema,
            signal,
        });
    }

    /** `GET /agent/plans`. */
    plans(signal?: AbortSignal): Promise<AgentListedPlan[]> {
        return this.#call('GET', '/agent/plans', { as: 'agent', schema: agentPlansSchema, signal });
    }

    /**
     * `POST /agent/plans`: a plan for the merchant to sign. Nothing on chain.
     * No slug, no receiver, no end: the API takes none from an agent.
     */
    preparePlan(
        plan: {
            name: string;
            mint: string;
            amount: string;
            periodHours: number;
            description?: string | undefined;
            websiteUrl?: string | undefined;
            retryAttempts?: number | undefined;
            retryDelayMinutes?: number | undefined;
        },
        signal?: AbortSignal,
    ): Promise<PreparedPlan> {
        return this.#call('POST', '/agent/plans', {
            as: 'agent',
            body: plan,
            schema: preparedPlanSchema,
            signal,
        });
    }

    /** `GET /agent/plans/:id`. */
    plan(planId: string, signal?: AbortSignal): Promise<AgentPlanDetail> {
        return this.#call('GET', `/agent/plans/${pathSegment(planId)}`, {
            as: 'agent',
            schema: agentPlanDetailSchema,
            signal,
        });
    }

    /** `PATCH /agent/plans/:id/retry-policy`. An empty policy clears it. */
    updateRetryPolicy(
        planId: string,
        policy: { retryAttempts: number; retryDelayMinutes: number } | Record<string, never>,
        signal?: AbortSignal,
    ): Promise<AgentPlan> {
        return this.#call('PATCH', `/agent/plans/${pathSegment(planId)}/retry-policy`, {
            as: 'agent',
            body: policy,
            schema: agentPlanSchema,
            signal,
        });
    }

    /** `GET /agent/subscriptions`. */
    subscriptions(
        query: {
            plan?: string | undefined;
            status?: string | undefined;
            q?: string | undefined;
            days?: number | undefined;
            page?: number | undefined;
            limit?: number | undefined;
        },
        signal?: AbortSignal,
    ): Promise<AgentSubscriptionPage> {
        return this.#call('GET', '/agent/subscriptions', {
            as: 'agent',
            query,
            schema: agentSubscriptionPageSchema,
            signal,
        });
    }

    /** `GET /agent/subscriptions/:id`. */
    subscription(subscriptionId: string, signal?: AbortSignal): Promise<AgentSubscription> {
        return this.#call('GET', `/agent/subscriptions/${pathSegment(subscriptionId)}`, {
            as: 'agent',
            schema: agentSubscriptionSchema,
            signal,
        });
    }

    /** `POST /agent/subscriptions/:id/retry`: charges a subscriber. No body. */
    retryCharge(subscriptionId: string, signal?: AbortSignal): Promise<AgentSubscription> {
        return this.#call('POST', `/agent/subscriptions/${pathSegment(subscriptionId)}/retry`, {
            as: 'agent',
            schema: agentSubscriptionSchema,
            signal,
        });
    }

    /** `GET /agent/access` with a plan: one answer. */
    access(query: AccessQuery & { plan: string }, signal?: AbortSignal): Promise<AccessAnswer> {
        return this.#call('GET', '/agent/access', {
            as: 'agent',
            query,
            schema: agentAccessSchema,
            signal,
        });
    }

    /** `GET /agent/access` without a plan: every plan the customer has. */
    accessList(query: AccessQuery, signal?: AbortSignal): Promise<AccessList> {
        return this.#call('GET', '/agent/access', {
            as: 'agent',
            query,
            schema: agentAccessListSchema,
            signal,
        });
    }

    /** `GET /agent/events` without a day: the days that had anything, ten a page. */
    eventDays(
        query: EventsQuery & { days?: number | undefined; page?: number | undefined },
        signal?: AbortSignal,
    ): Promise<AgentEventDays> {
        return this.#call('GET', '/agent/events', {
            as: 'agent',
            query,
            schema: agentEventDaysSchema,
            signal,
        });
    }

    /** `GET /agent/events?day=`: that day, week or month in full. */
    eventsOn(
        query: EventsQuery & { day: string },
        signal?: AbortSignal,
    ): Promise<AgentEventLine[]> {
        return this.#call('GET', '/agent/events', {
            as: 'agent',
            query,
            schema: agentEventLinesSchema,
            signal,
        });
    }

    /** `GET /agent/events/upcoming`. */
    upcoming(
        query: {
            plan?: string | undefined;
            days?: number | undefined;
            group?: string | undefined;
            q?: string | undefined;
        },
        signal?: AbortSignal,
    ): Promise<AgentUpcomingLine[]> {
        return this.#call('GET', '/agent/events/upcoming', {
            as: 'agent',
            query,
            schema: agentUpcomingSchema,
            signal,
        });
    }

    /** `GET /agent/overview`. */
    overview(
        query: { plan?: string | undefined; days?: number | undefined },
        signal?: AbortSignal,
    ): Promise<AgentOverview> {
        return this.#call('GET', '/agent/overview', {
            as: 'agent',
            query,
            schema: agentOverviewSchema,
            signal,
        });
    }

    /** `GET /agent/webhooks`. */
    webhooks(signal?: AbortSignal): Promise<WebhookEndpoint[]> {
        return this.#call('GET', '/agent/webhooks', {
            as: 'agent',
            schema: webhookEndpointsSchema,
            signal,
        });
    }

    /** `POST /agent/webhooks`: answers the endpoint with its secret in clear. */
    createWebhook(
        body: { url: string; events: readonly string[]; enabled?: boolean | undefined },
        signal?: AbortSignal,
    ): Promise<WebhookEndpointWithSecret> {
        return this.#call('POST', '/agent/webhooks', {
            as: 'agent',
            body,
            schema: webhookEndpointWithSecretSchema,
            signal,
        });
    }

    /** `PATCH /agent/webhooks/:endpointId`. */
    updateWebhook(
        endpointId: string,
        body: {
            url?: string | undefined;
            events?: readonly string[] | undefined;
            enabled?: boolean | undefined;
        },
        signal?: AbortSignal,
    ): Promise<WebhookEndpoint> {
        return this.#call('PATCH', `/agent/webhooks/${pathSegment(endpointId)}`, {
            as: 'agent',
            body,
            schema: webhookEndpointSchema,
            signal,
        });
    }

    /** `DELETE /agent/webhooks/:endpointId`: 204. */
    async deleteWebhook(endpointId: string, signal?: AbortSignal): Promise<void> {
        await this.#call('DELETE', `/agent/webhooks/${pathSegment(endpointId)}`, {
            as: 'agent',
            schema: nothingSchema,
            signal,
        });
    }

    /** `GET /agent/webhooks/:endpointId/secret`: the signing secret in clear. Never logged. */
    webhookSecret(endpointId: string, signal?: AbortSignal): Promise<{ secret: string }> {
        return this.#call('GET', `/agent/webhooks/${pathSegment(endpointId)}/secret`, {
            as: 'agent',
            schema: webhookSecretSchema,
            signal,
        });
    }

    /** `POST /agent/webhooks/:endpointId/secret/regenerate`: the old secret stops at once. */
    regenerateWebhookSecret(
        endpointId: string,
        signal?: AbortSignal,
    ): Promise<WebhookEndpointWithSecret> {
        return this.#call('POST', `/agent/webhooks/${pathSegment(endpointId)}/secret/regenerate`, {
            as: 'agent',
            schema: webhookEndpointWithSecretSchema,
            signal,
        });
    }

    /** `GET /agent/webhooks/:endpointId/deliveries`. */
    webhookDeliveries(
        endpointId: string,
        query: { limit?: number | undefined; startingAfter?: string | undefined },
        signal?: AbortSignal,
    ): Promise<WebhookDeliveryPage> {
        return this.#call('GET', `/agent/webhooks/${pathSegment(endpointId)}/deliveries`, {
            as: 'agent',
            query,
            schema: webhookDeliveryPageSchema,
            signal,
        });
    }

    /** `POST /agent/webhooks/:endpointId/test`: posts to the merchant's endpoint. */
    sendTestWebhook(
        endpointId: string,
        body: { event?: string | undefined },
        signal?: AbortSignal,
    ): Promise<WebhookDelivery> {
        return this.#call('POST', `/agent/webhooks/${pathSegment(endpointId)}/test`, {
            as: 'agent',
            body,
            schema: webhookDeliverySchema,
            signal,
        });
    }

    /** Both credentials, together. The one place either is written on a request. */
    #credentials(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.#token}`,
            [SERVICE_SECRET_HEADER]: revealSecret(this.#serviceSecret),
        };
    }

    /** A text from the API, with a credential it would quote back taken out. */
    #scrub(text: string): string {
        return this.#serviceSecret.scrub(text).replaceAll(this.#token, REDACTED);
    }

    async #call<T>(method: string, path: string, options: CallOptions<T>): Promise<T> {
        const url = apiUrl(this.#baseUrl, path, options.query);
        const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

        const { response, text } = await this.#exchange(
            url,
            {
                method,
                headers: {
                    ...(options.as === 'agent' && this.#credentials()),
                    Accept: 'application/json',
                    'User-Agent': `@mesub/mcp/${VERSION}`,
                    'Mesub-Version': API_VERSION,
                    ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
                },
                ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
                // The credentials go to the Mesub API and nowhere it points at.
                redirect: 'error',
            },
            timeoutMs,
            options.signal,
        );

        const body = parsed(text);
        if (!response.ok) throw this.#errorFrom(response, body === UNREADABLE ? undefined : body);

        // A page, a banner, half an answer: never taken for "nothing", which is what a 204 says.
        const result = options.schema.safeParse(body);
        if (body === UNREADABLE || !result.success) {
            throw new MesubApiError('Mesub answered with a body this server cannot read.', {
                status: response.status,
                code: 'unexpected',
                retryable: false,
            });
        }
        return result.data;
    }

    /**
     * One request and the whole of its answer, under ONE deadline: the
     * headers and the body. An API that answers its headers and then stalls,
     * or drips its body, is given up on like one that never answers.
     *
     * The deadline is raced, not only signalled: aborting the fetch is what
     * frees the socket, and the race is what ends the wait whatever the fetch
     * does with its signal.
     */
    async #exchange(
        url: URL,
        init: RequestInit,
        timeoutMs: number,
        caller: AbortSignal | undefined,
    ): Promise<{ response: Response; text: string }> {
        const abort = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let ended: 'deadline' | 'caller' | 'too long' | undefined;

        const end = (why: NonNullable<typeof ended>) => {
            ended ??= why;
            abort.abort();
            // Cancelling the read is what lets go of a body already coming.
            void reader?.cancel().catch(() => {});
        };
        const stopped = new Promise<never>((_resolve, reject) => {
            abort.signal.addEventListener('abort', () => reject(new Error('stopped')), {
                once: true,
            });
        });
        // Nobody may be listening any more when it rejects.
        stopped.catch(() => {});

        const timer = setTimeout(() => end('deadline'), timeoutMs);
        const onCallerLeft = () => end('caller');
        caller?.addEventListener('abort', onCallerLeft, { once: true });
        if (caller?.aborted) end('caller');

        const exchange = (async () => {
            const response = await this.#fetch(url, { ...init, signal: abort.signal });
            const chunks: Uint8Array[] = [];
            let size = 0;
            reader = response.body?.getReader();
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_RESPONSE_BYTES) {
                    end('too long');
                    throw new Error('too long');
                }
                chunks.push(value);
            }
            return { response, text: Buffer.concat(chunks).toString('utf8') };
        })();
        // The race may be over before it settles.
        exchange.catch(() => {});

        try {
            return await Promise.race([exchange, stopped]);
        } catch {
            end('caller');
            if (ended === 'too long') {
                throw new MesubApiError(
                    'Mesub answered with more than this server reads at once.',
                    {
                        status: null,
                        code: 'response_too_large',
                        retryable: false,
                    },
                );
            }
            // No cause kept, and none of its message: it may quote the URL or a header.
            const message =
                ended === 'deadline'
                    ? `Mesub did not answer within ${timeoutMs} ms.`
                    : 'Could not reach the Mesub API.';
            throw new MesubApiError(message, {
                status: null,
                code: 'unavailable',
                retryable: true,
            });
        } finally {
            clearTimeout(timer);
            caller?.removeEventListener('abort', onCallerLeft);
        }
    }

    /**
     * The error a Mesub error body describes: Nest's `statusCode` and `message`,
     * plus a stable `code` and a `retryable` flag. Without them, as from a proxy
     * in front, the status alone decides.
     */
    #errorFrom(response: Response, body: unknown): MesubApiError {
        const { status } = response;
        const { code, retryable, walletUrl } = isRecord(body) ? body : {};

        // Scrubbed whole, then cut: a cut must not leave half a credential behind.
        const message = this.#scrub(messageFrom(body, status)).slice(0, MAX_MESSAGE_LENGTH);

        return new MesubApiError(message, {
            status,
            code:
                typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)
                    ? code
                    : codeForStatus(status),
            retryable:
                typeof retryable === 'boolean'
                    ? retryable
                    : status === 408 || status === 429 || status >= 500,
            retryAfterSeconds: retryAfter(response.headers.get('retry-after')),
            // Kept only as an address of the dashboard: never a text to relay.
            walletUrl: isLink(walletUrl) ? walletUrl : null,
        });
    }
}

/** `message` is a string, or a list when the validation refused several fields. */
function messageFrom(body: unknown, status: number): string {
    const fallback = `Mesub answered with HTTP ${status}.`;
    if (!isRecord(body)) return fallback;

    const { message } = body;
    const parts = (Array.isArray(message) ? message : [message]).filter(
        (part): part is string => typeof part === 'string' && part !== '',
    );
    return parts.length > 0 ? parts.join('; ') : fallback;
}

/** Seconds, from a `Retry-After` in seconds or as an HTTP date. */
function retryAfter(header: string | null): number | null {
    if (header === null || header.trim() === '') return null;
    const seconds = Number(header);
    const value = Number.isNaN(seconds) ? (Date.parse(header) - Date.now()) / 1000 : seconds;
    return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;
}

/** An answer that has a body, and whose body is not JSON. */
const UNREADABLE = Symbol('unreadable');

/** The JSON of an answer. Undefined for an empty one, which is what a 204 is. */
function parsed(text: string): unknown {
    if (text === '') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return UNREADABLE;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
