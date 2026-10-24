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

/** As long as the longest external id the API takes. */
export const MAX_SEARCH_LENGTH = 255;

/** The shortest start of a signature the API matches: a shorter one would match too much. */
export const SIGNATURE_PREFIX_MIN = 8;

/** Part of a wallet, an id or a signature to look for. */
export const searchInput = (what: string) =>
    z
        .string()
        .max(MAX_SEARCH_LENGTH)
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\u0000-\u001f\u007f]+$/, 'No control characters.')
        .describe(what);

export const MAX_DAYS = 3650;

/** How many days back the event log reaches: Mesub keeps events 45 days, then purges them. */
export const JOURNAL_DAYS = 45;

export const daysInput = (what: string) =>
    z.number().int().min(1).max(MAX_DAYS).default(30).describe(what);

/**
 * Which project a tool falls back on when `project` is left out, as the API
 * decides it (its `AGENT_TOOL_PROJECT`): every project the connection
 * reaches, the pin or the organization's only one, or the pin alone.
 */
export type ProjectRule = 'any' | 'one' | 'write';

const NAMED = 'The project: its id or exact name, from `list_projects`.';
const LEFT_OUT: Record<ProjectRule, string> = {
    any: 'Left out: every project this connection reaches.',
    one: "Left out: the pinned project, or the organization's only one.",
    write: 'Required unless the connection is pinned to one project.',
};

/** The longest id or name sent: past any name the dashboard takes. */
export const MAX_PROJECT_LENGTH = 100;

/**
 * The project a tool works on, sent as it is in the `project` query
 * parameter. The API decides what the connection reaches: this server never
 * picks one, and never sends the one of the token.
 */
export const projectInput = (rule: ProjectRule) =>
    z
        .string()
        .max(MAX_PROJECT_LENGTH)
        // One character at least, none of them a control character.
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\u0000-\u001f\u007f]+$/, 'One character at least, and no control characters.')
        .describe(`${NAMED} ${LEFT_OUT[rule]}`)
        .optional();
