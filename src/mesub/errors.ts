export interface MesubApiErrorOptions {
    status: number | null;
    code: string;
    retryable: boolean;
    retryAfterSeconds?: number | null;
    walletUrl?: string | null;
    cause?: unknown;
}

/**
 * Every failure of a call to the Mesub API. `code` is the one Mesub's error
 * body names (`plan_not_found`, `rate_limited`, ...), stable and made to be
 * branched on. When no Mesub error came back, it is what the status says,
 * `unavailable` when nothing answered, `unexpected` for an answer that cannot
 * be read, `response_too_large` for one longer than this server reads.
 */
export class MesubApiError extends Error {
    override readonly name = 'MesubApiError';
    /** The HTTP status, or null when no response came back. */
    readonly status: number | null;
    readonly code: string;
    /** Whether the same call, sent again unchanged, may succeed later. */
    readonly retryable: boolean;
    /** From `Retry-After`, when Mesub sent one. */
    readonly retryAfterSeconds: number | null;
    /** Where a merchant connects a wallet, when a refusal names it: an address of the dashboard, checked. */
    readonly walletUrl: string | null;

    constructor(message: string, options: MesubApiErrorOptions) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable;
        this.retryAfterSeconds = options.retryAfterSeconds ?? null;
        this.walletUrl = options.walletUrl ?? null;
    }
}

/** The code of a refusal whose body names none: the back's own table, by status. */
export function codeForStatus(status: number): string {
    if (status === 400) return 'invalid_request';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    if (status === 413) return 'payload_too_large';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'unavailable';
    if (status >= 500) return 'internal_error';
    return 'unexpected';
}
