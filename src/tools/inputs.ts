import * as z from 'zod';

// What several tools take. Every argument is bounded and shaped here, before
// anything is sent to the Mesub API.

/** A Mesub id: a short run of letters, digits, hyphens and underscores. Never a path. */
export const idInput = (what: string) =>
    z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, 'An id is 1 to 64 letters, digits, hyphens or underscores.')
        .describe(what);

export const planFilter = idInput(
    'Only this plan: its id, as `list_plans` returns it. Left out: every plan of the project.',
).optional();

export const MAX_SEARCH_LENGTH = 100;

/** Part of a wallet, an id or a signature to look for. */
export const searchInput = (what: string) =>
    z
        .string()
        .max(MAX_SEARCH_LENGTH)
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\u0000-\u001f\u007f]+$/, 'No control characters.')
        .describe(what);

export const MAX_DAYS = 3650;

export const daysInput = (what: string) =>
    z.number().int().min(1).max(MAX_DAYS).default(30).describe(what);
