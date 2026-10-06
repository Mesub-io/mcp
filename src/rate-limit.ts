import { createHash } from 'node:crypto';

/*
 * Everything here lives in the memory of ONE instance: two instances count
 * apart, and a restart forgets. That is enough for what it is for, which is
 * to keep a flood away from the Mesub API, and it is all it can be while the
 * server keeps no shared store. Nothing here ever lets a request in: a
 * counter and a remembered refusal can only refuse.
 */

export const WINDOW_MS = 60_000;

/** Requests of one address with no token, or one that cannot be a Mesub token. Never reach the API. */
export const ANONYMOUS_PER_ADDRESS = 60;

/**
 * Tokens of one address put to the API and not let in, a minute: refused,
 * unanswered, or over their connection's limit. A token let in gives its
 * place back, so an address is never held back by its valid traffic.
 */
export const FAILED_CHECKS_PER_ADDRESS = 30;

/**
 * Requests of one connection, a minute. Under half of what the API grants a
 * connection at its own door (300), since a request here is one check there
 * plus what the tool calls.
 */
export const PER_CONNECTION = 120;

/**
 * How long a token the API just refused is refused here without asking again.
 * Safe at any length, since a refused token never becomes good: it is
 * unknown, past its hour or revoked. Kept short all the same.
 */
export const REFUSED_TOKEN_TTL_MS = 30_000;
export const REFUSED_TOKENS_MAX = 10_000;

/** How many addresses, or connections, one limiter counts apart at most. */
export const MAX_KEYS = 50_000;

export interface Limits {
    anonymousPerAddress: number;
    failedChecksPerAddress: number;
    perConnection: number;
}

export const DEFAULT_LIMITS: Limits = {
    anonymousPerAddress: ANONYMOUS_PER_ADDRESS,
    failedChecksPerAddress: FAILED_CHECKS_PER_ADDRESS,
    perConnection: PER_CONNECTION,
};

export type Taken =
    | {
          ok: true;
          /** Gives the place back, once, if its window is still the current one. */ refund: () => void;
      }
    | {
          ok: false;
          retryAfterSeconds: number;
          /** The first refusal of this key in this window. */ first: boolean;
      };

export interface WindowLimiterOptions {
    limit: number;
    windowMs: number;
    maxKeys: number;
    now: () => number;
}

interface Window {
    count: number;
    resetAt: number;
    refused: boolean;
}

/** Every key past `maxKeys` counts here, together. */
const OVERFLOW = '\u0000overflow';

/**
 * At most `limit` per key and fixed window. A fixed window lets up to twice
 * the limit through across the edge of two windows: good enough to cap a
 * flood, and one number per key to hold. Memory is bounded: once `maxKeys`
 * keys are counted, windows that ended are dropped, and if that frees nothing
 * every new key shares one budget instead of getting its own.
 */
export class WindowLimiter {
    readonly #options: WindowLimiterOptions;
    readonly #windows = new Map<string, Window>();

    constructor(options: WindowLimiterOptions) {
        this.#options = options;
    }

    get size(): number {
        return this.#windows.size;
    }

    take(key: string): Taken {
        const now = this.#options.now();
        const window = this.#windowOf(key, now);

        if (window.count >= this.#options.limit) {
            const first = !window.refused;
            window.refused = true;
            return {
                ok: false,
                retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
                first,
            };
        }

        window.count += 1;
        let refunded = false;
        return {
            ok: true,
            refund: () => {
                // Only into the window it was taken from: a later one owes nothing.
                if (refunded || this.#options.now() >= window.resetAt) return;
                refunded = true;
                window.count -= 1;
            },
        };
    }

    #windowOf(key: string, now: number): Window {
        const known = this.#windows.get(key);
        if (known && now < known.resetAt) return known;
        if (known) this.#windows.delete(key);

        if (this.#windows.size >= this.#options.maxKeys) this.#sweep(now);
        const name = this.#windows.size >= this.#options.maxKeys ? OVERFLOW : key;

        const shared = this.#windows.get(name);
        if (shared && now < shared.resetAt) return shared;

        const fresh = { count: 0, resetAt: now + this.#options.windowMs, refused: false };
        this.#windows.set(name, fresh);
        return fresh;
    }

    #sweep(now: number): void {
        for (const [key, window] of this.#windows) {
            if (now >= window.resetAt) this.#windows.delete(key);
        }
    }
}

export interface RefusedTokensOptions {
    ttlMs: number;
    max: number;
    now: () => number;
}

/**
 * The tokens the API just refused, so the same one sent again is refused
 * without another call. Only their SHA-256 is kept, never a token. Bounded:
 * past `max`, what ran out goes, then the oldest. Forgetting one costs a call
 * to the API and nothing else.
 */
export class RefusedTokens {
    readonly #options: RefusedTokensOptions;
    /** Digest to the time it stops counting, oldest first. */
    readonly #until = new Map<string, number>();

    constructor(options: RefusedTokensOptions) {
        this.#options = options;
    }

    get size(): number {
        return this.#until.size;
    }

    has(token: string): boolean {
        const digest = digestOf(token);
        const until = this.#until.get(digest);
        if (until === undefined) return false;
        if (this.#options.now() < until) return true;

        this.#until.delete(digest);
        return false;
    }

    add(token: string): void {
        const now = this.#options.now();
        const digest = digestOf(token);

        // Deleted first, so a token refused again is the newest again.
        this.#until.delete(digest);
        if (this.#until.size >= this.#options.max) {
            for (const [key, until] of this.#until) {
                if (now >= until) this.#until.delete(key);
            }
        }
        while (this.#until.size >= this.#options.max) {
            const oldest = this.#until.keys().next();
            if (oldest.done) break;
            this.#until.delete(oldest.value);
        }
        this.#until.set(digest, now + this.#options.ttlMs);
    }
}

function digestOf(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
}
