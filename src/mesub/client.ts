import type * as z from 'zod';

import { VERSION } from '../version.js';
import { MesubApiError, codeForStatus } from './errors.js';
import { apiHealthSchema, type ApiHealth } from './schemas.js';

/**
 * The version of the Mesub API this server was written against, sent in the
 * `Mesub-Version` header of every call, as `@mesub/node` does.
 */
export const API_VERSION = '2026-10-02';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 500;

export interface MesubClientOptions {
    /** Without a trailing slash. */
    baseUrl: string;
    /** The caller's access token, passed through as it came. Never logged. */
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined;

interface CallOptions<T> {
    query?: Record<string, QueryValue>;
    body?: unknown;
    /** What a 2xx must look like. */
    schema: z.ZodType<T>;
    /** The tool call's own signal: a caller that leaves stops the call. */
    signal?: AbortSignal | undefined;
}

/**
 * The Mesub HTTP API, as one caller: every call carries that caller's token.
 * One method per route a tool needs, nothing more. No retry here: a tool
 * reports the failure and the agent decides.
 */
export class MesubClient {
    readonly #baseUrl: string;
    readonly #token: string;
    readonly #fetch: typeof fetch;
    readonly #timeoutMs: number;

    constructor(options: MesubClientOptions) {
        this.#baseUrl = options.baseUrl;
        this.#token = options.token;
        this.#fetch = options.fetch ?? fetch;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /** `GET /health`: whether the API is up. Needs no authentication. */
    health(signal?: AbortSignal): Promise<ApiHealth> {
        return this.#call('GET', '/health', { schema: apiHealthSchema, signal });
    }

    async #call<T>(method: string, path: string, options: CallOptions<T>): Promise<T> {
        // Never `new URL(path, base)`, which drops a path the base carries.
        const url = new URL(this.#baseUrl + path);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }

        const timeout = AbortSignal.timeout(this.#timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

        let response: Response;
        let text: string;
        try {
            response = await this.#fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${this.#token}`,
                    Accept: 'application/json',
                    'User-Agent': `@mesub/mcp/${VERSION}`,
                    'Mesub-Version': API_VERSION,
                    ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
                },
                ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
                // The token goes to the Mesub API and nowhere it points at.
                redirect: 'error',
                signal,
            });
            text = await response.text();
        } catch (cause) {
            // No cause's message here: it may quote the URL or a header.
            const message = timeout.aborted
                ? `Mesub did not answer within ${this.#timeoutMs} ms.`
                : 'Could not reach the Mesub API.';
            throw new MesubApiError(message, {
                status: null,
                code: 'unavailable',
                retryable: true,
                cause,
            });
        }

        const body = parsed(text);
        if (!response.ok) throw errorFrom(response, body);

        const result = options.schema.safeParse(body);
        if (!result.success) {
            throw new MesubApiError('Mesub answered with a body this server cannot read.', {
                status: response.status,
                code: 'unexpected',
                retryable: false,
            });
        }
        return result.data;
    }
}

/**
 * The error a Mesub error body describes: Nest's `statusCode` and `message`,
 * plus a stable `code` and a `retryable` flag. Without them, as from a proxy
 * in front, the status alone decides.
 */
function errorFrom(response: Response, body: unknown): MesubApiError {
    const { status } = response;
    const { code, retryable } = isRecord(body) ? body : {};

    return new MesubApiError(messageFrom(body, status), {
        status,
        code: typeof code === 'string' && code !== '' ? code : codeForStatus(status),
        retryable:
            typeof retryable === 'boolean'
                ? retryable
                : status === 408 || status === 429 || status >= 500,
        retryAfterSeconds: retryAfter(response.headers.get('retry-after')),
    });
}

/** `message` is a string, or a list when the validation refused several fields. */
function messageFrom(body: unknown, status: number): string {
    const fallback = `Mesub answered with HTTP ${status}.`;
    if (!isRecord(body)) return fallback;

    const { message } = body;
    const parts = (Array.isArray(message) ? message : [message]).filter(
        (part): part is string => typeof part === 'string' && part !== '',
    );
    return parts.length > 0 ? parts.join('; ').slice(0, MAX_MESSAGE_LENGTH) : fallback;
}

/** Seconds, from a `Retry-After` in seconds or as an HTTP date. */
function retryAfter(header: string | null): number | null {
    if (header === null || header.trim() === '') return null;
    const seconds = Number(header);
    const value = Number.isNaN(seconds) ? (Date.parse(header) - Date.now()) / 1000 : seconds;
    return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;
}

function parsed(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
