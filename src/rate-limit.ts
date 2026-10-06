import { createHash } from 'node:crypto';

/*
 * Everything here lives in the memory of ONE instance: two instances count
 * apart, and a restart forgets.
 *
 * The rule: a limit protects the Mesub API from a flood. It is never a way
 * for one caller to keep another out. So nothing here refuses a request for
 * what somebody else sent, from the same address or from any other:
 *
 * - a connection is refused past its own rate, and only that connection;
 * - a token this instance has not yet seen accepted waits for one of a few
 *   places to be checked, per address and for the whole instance, and is told
 *   to come back when it waited too long. No count is kept against anybody;
 * - a request without a token is always answered: the 401 costs nothing;
 * - a table that is full drops its oldest keys. It never refuses a new one.
 *
 * And nothing here ever lets a request in. A token seen accepted before is
 * still checked with the API on every request: what is remembered of it only
 * decides where it waits.
 */

export const WINDOW_MS = 60_000;

/**
 * Requests of one connection, a minute. Under half of what the API grants a
 * connection at its own door (300), since a request here is one check there
 * plus what the tool calls.
 */
export const PER_CONNECTION = 120;

/**
 * Checks in flight at once for tokens this instance has not seen accepted:
 * for one address, and for the whole instance. This is what a flood of
 * made-up tokens costs the API: never more calls at a time than this.
 */
export const CHECKS_PER_ADDRESS = 8;
export const CHECKS_TOTAL = 32;

/** How many such checks may wait for a place, and for how long, before being shed. */
export const WAITING_PER_ADDRESS = 64;
export const WAITING_TOTAL = 1024;
export const MAX_WAIT_MS = 3000;

/** Log lines about refused requests, per address and minute. Past it, silence, never a refusal. */
export const LOG_LINES_PER_ADDRESS = 60;

/**
 * How long a token the API just refused is refused here without asking again.
 * Five seconds: longer than the burst of retries a client makes on a dead
 * token, and short enough that a token refused by mistake (the API reading a
 * copy of its database that lags, say) is good again almost at once. A
 * replayed dead token costs the API twelve calls a minute.
 */
export const REFUSED_TOKEN_TTL_MS = 5000;
export const REFUSED_TOKENS_MAX = 10_000;

/** How many keys one table holds at most: addresses, connections, tokens seen. */
export const MAX_KEYS = 50_000;

export interface Limits {
    perConnection: number;
    checksPerAddress: number;
    checksTotal: number;
    waitingPerAddress: number;
    waitingTotal: number;
    maxWaitMs: number;
    logLinesPerAddress: number;
    maxKeys: number;
}

export const DEFAULT_LIMITS: Limits = {
    perConnection: PER_CONNECTION,
    checksPerAddress: CHECKS_PER_ADDRESS,
    checksTotal: CHECKS_TOTAL,
    waitingPerAddress: WAITING_PER_ADDRESS,
    waitingTotal: WAITING_TOTAL,
    maxWaitMs: MAX_WAIT_MS,
    logLinesPerAddress: LOG_LINES_PER_ADDRESS,
    maxKeys: MAX_KEYS,
};

export type Taken =
    | {
          ok: true;
          /** Gives the place back, once, if its window is still the current one. */
          refund: () => void;
      }
    | {
          ok: false;
          retryAfterSeconds: number;
          /** The first refusal of this key in this window. */
          first: boolean;
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

/**
 * At most `limit` per key and fixed window. A fixed window lets up to twice
 * the limit through across the edge of two windows: good enough to cap a
 * flood, and one number per key to hold.
 *
 * Memory is bounded without anybody paying for it: once `maxKeys` keys are
 * counted, windows that ended are dropped, then the least recently used. A
 * key dropped while it still counted starts afresh. So whoever fills the
 * table resets counters, their own included, and keeps nobody out.
 */
export class WindowLimiter {
    readonly #options: WindowLimiterOptions;
    /** Least recently used first. */
    readonly #windows = new Map<string, Window>();
    #dropped = 0;

    constructor(options: WindowLimiterOptions) {
        this.#options = options;
    }

    get size(): number {
        return this.#windows.size;
    }

    /** How many keys were dropped while they still counted. */
    get dropped(): number {
        return this.#dropped;
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
        if (known) {
            this.#windows.delete(key);
            if (now < known.resetAt) {
                // Set again: the most recently used is the last to go.
                this.#windows.set(key, known);
                return known;
            }
        }

        if (this.#windows.size >= this.#options.maxKeys) this.#makeRoom(now);

        const fresh = { count: 0, resetAt: now + this.#options.windowMs, refused: false };
        this.#windows.set(key, fresh);
        return fresh;
    }

    #makeRoom(now: number): void {
        for (const [key, window] of this.#windows) {
            if (now >= window.resetAt) this.#windows.delete(key);
        }
        while (this.#windows.size >= this.#options.maxKeys) {
            const oldest = this.#windows.keys().next();
            if (oldest.done) break;
            this.#windows.delete(oldest.value);
            this.#dropped += 1;
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

export interface KnownTokensOptions {
    max: number;
    now: () => number;
}

/**
 * The tokens the API accepted on this instance, each with its connection,
 * until the token expires. NOT a verdict: a known token is checked with the
 * API on every request like any other. What knowing it changes is where it
 * stands: it does not wait behind tokens nobody ever vouched for, and its
 * connection's rate is known before the API is asked. Only a SHA-256 is kept.
 */
export class KnownTokens {
    readonly #options: KnownTokensOptions;
    /** Least recently used first. */
    readonly #known = new Map<string, { connectionId: string; until: number }>();

    constructor(options: KnownTokensOptions) {
        this.#options = options;
    }

    get size(): number {
        return this.#known.size;
    }

    connectionOf(token: string): string | undefined {
        const digest = digestOf(token);
        const entry = this.#known.get(digest);
        if (entry === undefined) return undefined;

        this.#known.delete(digest);
        if (this.#options.now() >= entry.until) return undefined;
        this.#known.set(digest, entry);
        return entry.connectionId;
    }

    /** `until`: when the token expires, in milliseconds. */
    add(token: string, connectionId: string, until: number): void {
        const digest = digestOf(token);
        this.#known.delete(digest);
        while (this.#known.size >= this.#options.max) {
            const oldest = this.#known.keys().next();
            if (oldest.done) break;
            this.#known.delete(oldest.value);
        }
        this.#known.set(digest, { connectionId, until });
    }

    delete(token: string): void {
        this.#known.delete(digestOf(token));
    }
}

export interface CheckLaneOptions {
    /** Checks in flight at once for one address. */
    perAddress: number;
    /** And for every address together. */
    total: number;
    waitingPerAddress: number;
    waitingTotal: number;
    maxWaitMs: number;
}

/** A place in the lane. `leave` gives it back, once. */
export interface Pass {
    leave: () => void;
}

interface Waiter {
    key: string;
    settle: (pass: Pass | undefined) => void;
}

interface Slot {
    running: number;
    waiting: Waiter[];
}

const FREE_PASS: Pass = { leave: () => {} };

/**
 * Where a token nobody vouched for yet waits to be checked: a few at a time
 * per address, a few more for the whole instance, the addresses served in
 * turns. Whoever waited too long, or finds no room to wait, is shed: told to
 * come back, with no verdict and nothing held against them.
 *
 * Nothing is counted over time. The moment a flood stops, or a place frees,
 * the next caller is served as if it never happened.
 */
export class CheckLane {
    readonly #options: CheckLaneOptions;
    /** In the order they are next served. Only addresses with something running or waiting. */
    readonly #slots = new Map<string, Slot>();
    #running = 0;
    #waiting = 0;

    constructor(options: CheckLaneOptions) {
        this.#options = options;
    }

    get running(): number {
        return this.#running;
    }

    get waiting(): number {
        return this.#waiting;
    }

    get addresses(): number {
        return this.#slots.size;
    }

    /**
     * A place to check `key` (a token) for `address`, now or once one frees.
     * Undefined: shed. `signal`: the caller left, and waits no more.
     */
    enter(address: string, key: string, signal?: AbortSignal): Promise<Pass | undefined> {
        const slot = this.#slots.get(address) ?? { running: 0, waiting: [] };
        this.#slots.set(address, slot);

        if (
            slot.waiting.length === 0 &&
            slot.running < this.#options.perAddress &&
            this.#running < this.#options.total
        ) {
            return Promise.resolve(this.#run(address, slot));
        }
        if (
            signal?.aborted ||
            slot.waiting.length >= this.#options.waitingPerAddress ||
            (this.#waiting >= this.#options.waitingTotal && !this.#makeRoomFor(slot))
        ) {
            this.#forget(address, slot);
            return Promise.resolve(undefined);
        }

        return new Promise((resolve) => {
            const waiter: Waiter = {
                key,
                settle: (pass) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', giveUp);
                    resolve(pass);
                },
            };
            const giveUp = () => {
                const at = slot.waiting.indexOf(waiter);
                if (at === -1) return;
                slot.waiting.splice(at, 1);
                this.#waiting -= 1;
                this.#forget(address, slot);
                waiter.settle(undefined);
            };
            const timer = setTimeout(giveUp, this.#options.maxWaitMs);
            // A wait must not keep a process that is stopping alive.
            timer.unref();
            signal?.addEventListener('abort', giveUp, { once: true });

            slot.waiting.push(waiter);
            this.#waiting += 1;
        });
    }

    /**
     * `key` is good: whoever waits on it goes through at once, beside the
     * lane. They are no longer what the lane is for.
     */
    promote(key: string): void {
        for (const [address, slot] of this.#slots) {
            const through = slot.waiting.filter((waiter) => waiter.key === key);
            if (through.length === 0) continue;

            slot.waiting = slot.waiting.filter((waiter) => waiter.key !== key);
            this.#waiting -= through.length;
            this.#forget(address, slot);
            for (const waiter of through) waiter.settle(FREE_PASS);
        }
    }

    /**
     * No room left to wait in: the address that takes the most of it gives up
     * its last place, if it takes more than the newcomer's address would. So
     * the room is shared between addresses, not kept by whoever filled it.
     */
    #makeRoomFor(newcomer: Slot): boolean {
        let most: [string, Slot] | undefined;
        for (const entry of this.#slots) {
            if (most === undefined || entry[1].waiting.length > most[1].waiting.length) {
                most = entry;
            }
        }
        if (most === undefined || most[1].waiting.length <= newcomer.waiting.length + 1) {
            return false;
        }

        const [address, slot] = most;
        const shed = slot.waiting.pop();
        if (shed === undefined) return false;
        this.#waiting -= 1;
        this.#forget(address, slot);
        shed.settle(undefined);
        return true;
    }

    #run(address: string, slot: Slot): Pass {
        slot.running += 1;
        this.#running += 1;
        let left = false;
        return {
            leave: () => {
                if (left) return;
                left = true;
                slot.running -= 1;
                this.#running -= 1;
                this.#forget(address, slot);
                this.#serve();
            },
        };
    }

    /** Gives every free place to the addresses that wait, each in its turn. */
    #serve(): void {
        let served = true;
        while (served && this.#running < this.#options.total && this.#waiting > 0) {
            served = false;
            // A copy: serving an address moves it, and the round must not meet it twice.
            for (const [address, slot] of Array.from(this.#slots)) {
                if (this.#running >= this.#options.total) break;
                if (slot.waiting.length === 0 || slot.running >= this.#options.perAddress) continue;

                const waiter = slot.waiting.shift();
                if (waiter === undefined) continue;
                this.#waiting -= 1;
                // To the back: the next free place is somebody else's.
                this.#slots.delete(address);
                this.#slots.set(address, slot);
                waiter.settle(this.#run(address, slot));
                served = true;
            }
        }
    }

    #forget(address: string, slot: Slot): void {
        if (slot.running === 0 && slot.waiting.length === 0 && this.#slots.get(address) === slot) {
            this.#slots.delete(address);
        }
    }
}

function digestOf(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
}
