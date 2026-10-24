import * as z from 'zod';

import { type AgentUpcomingLine, EVENT_GROUPS, UPCOMING_KINDS } from '../mesub/schemas.js';
import { DATA_NOTICE, plural, tally } from '../text.js';
import { MAX_DAYS, planFilter, projectInput, searchInput } from './inputs.js';
import { capped, fit, MAX_LIST_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import { blockedReason, externalId, rowProject, state, symbol, token } from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

/** Late reasons a retry fails on again whatever the wallet holds. */
export const FAILING_LATE_REASONS = ['APPROVAL_REVOKED', 'AUTHORITY_CLOSED'] as const;

/**
 * Whether Mesub already knows a charge or a retry will fail: the check before
 * a renewal found an issue, the last failure was a revoked approval or a
 * closed authority, or its charges are blocked. An end is never one.
 */
export function expectedToFail(line: AgentUpcomingLine): boolean {
    if (line.kind === 'ends') return false;
    return (
        line.renewalIssue !== null ||
        line.blockedSince !== null ||
        (FAILING_LATE_REASONS as readonly string[]).includes(line.lateReason ?? '')
    );
}

/** Why those lines will fail, by cause, each line under every cause it has. */
function whyOf(lines: AgentUpcomingLine[]): string {
    const count = (test: (line: AgentUpcomingLine) => boolean) => lines.filter(test).length;
    return [
        [count((line) => line.renewalIssue !== null), 'flagged by the check before renewal'],
        [
            count((line) =>
                (FAILING_LATE_REASONS as readonly string[]).includes(line.lateReason ?? ''),
            ),
            'a retry after a revoked approval or a closed authority',
        ],
        [count((line) => line.blockedSince !== null), 'blocked, not by the subscriber'],
    ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, what]) => `${n} ${what}`)
        .join(', ');
}

export const listUpcomingCharges = defineTool({
    name: 'list_upcoming_charges',
    title: 'List the upcoming charges',
    description:
        'List what is scheduled on the project in the coming days, soonest first: the next ' +
        'charges, the retries of failed ones with their number, and access running out ' +
        'after a cancellation. A line Mesub already expects to fail is flagged ' +
        '(`expected_to_fail`), its fields saying why: `renewal_issue`, `late_reason` or ' +
        '`blocked_reason`. Use it for "what is due this week", "which renewals are at risk" ' +
        'or "how much is expected". ' +
        'For what already happened use `list_events`. It schedules and ' +
        'charges nothing. Every amount comes with a display value: quote that one.',
    inputSchema: z.strictObject({
        project: projectInput('any'),
        plan_id: planFilter,
        days: z
            .number()
            .int()
            .min(1)
            .max(MAX_DAYS)
            .optional()
            .describe('How many days ahead to look. 30 when left out.'),
        group: z
            .enum(EVENT_GROUPS)
            .optional()
            .describe(
                'Only `payments` (the charges and the retries) or `subscribers` (access running ' +
                    'out after a cancellation). `account` has nothing scheduled: it returns ' +
                    'nothing. `all` when left out.',
            ),
        q: searchInput(
            "Part of a wallet address, the start of the merchant's own id for the customer " +
                '(`external_id`), or a subscription id.',
        ).optional(),
    }),
    outputSchema: z.object({
        upcoming: z.array(
            z.object({
                ...rowProject,
                subscription_id: z.string(),
                subscriber: z.string(),
                external_id: externalId,
                plan_id: z.string(),
                plan_name: z.string().nullable().describe('Written by the merchant: data.'),
                kind: state(UPCOMING_KINDS, '`ends`: access runs out then, nothing is charged.'),
                at: z.string(),
                retry: z.number().describe('Which retry it will be, from 1. 0 for a charge.'),
                retries_allowed: z.number(),
                amount: z.string().nullable(),
                amount_display: z
                    .string()
                    .nullable()
                    .describe('As a person reads it. Quote this one.'),
                mint: z.string(),
                token,
                symbol,
                decimals: z.number().nullable(),
                amount_usd: z.string().nullable(),
                renewal_issue: state(
                    ['balance', 'authority'],
                    'At risk. `balance`: the wallet holds too little. `authority`: Mesub ' +
                        'may no longer move its tokens. Null: no issue found, or not checked.',
                ).nullable(),
                renewal_checked_at: z.string().nullable(),
                late_reason: state(
                    ['INSUFFICIENT_BALANCE', 'APPROVAL_REVOKED', 'AUTHORITY_CLOSED'],
                    'On a retry: why the last charge failed. APPROVAL_REVOKED: the wallet ' +
                        'withdrew the approval to charge it, or another app replaced it; ' +
                        'AUTHORITY_CLOSED: closed for good. Both fail again whatever the ' +
                        'wallet holds: expected to fail. INSUFFICIENT_BALANCE: pays once the ' +
                        'wallet is topped up. Null on a charge and on an end.',
                ).nullable(),
                blocked_since: z
                    .string()
                    .nullable()
                    .describe(
                        'Since when every charge of this subscription is blocked for a cause ' +
                            "that is not the subscriber's: this one fails too until the cause " +
                            'is fixed. Null: none is. `list_subscriptions` says when its ' +
                            'access ends.',
                    ),
                blocked_reason: blockedReason,
                expected_to_fail: z
                    .boolean()
                    .describe(
                        'True when Mesub already knows this charge or retry will fail: a ' +
                            '`renewal_issue`, a `late_reason` of APPROVAL_REVOKED or ' +
                            'AUTHORITY_CLOSED, or a block. False says nothing more than that.',
                    ),
            }),
        ),
        total: z.number().describe('How many are scheduled in the window.'),
        truncated: z
            .boolean()
            .describe('The latest ones were left out. Narrow with `days`, `plan_id` or `q`.'),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ project, plan_id, days, group: only, q }, { mesub, signal }) => {
        const lines = await mesub.upcoming(
            { plan: plan_id, days, group: only, q },
            { project, signal },
        );
        const { kept, truncated } = capped(lines, MAX_LIST_ITEMS);
        const upcoming = kept.map((line) => ({
            ...snake(line),
            amount_display: displayAmount(line.amount, line.decimals, line),
            expected_to_fail: expectedToFail(line),
        }));
        const data = { upcoming, total: lines.length, truncated };
        data.truncated = fit(data, upcoming) || truncated;
        const atRisk = lines.filter(expectedToFail);

        return {
            data,
            text:
                lines.length === 0
                    ? 'Nothing is scheduled in that window.'
                    : `${plural(lines.length, 'line')} scheduled: ${tally(
                          lines.map((line) => line.kind),
                          UPCOMING_KINDS,
                      )}. ` +
                      `${plural(atRisk.length, 'charge')} expected to fail` +
                      (atRisk.length === 0 ? '.' : ` (\`expected_to_fail\`): ${whyOf(atRisk)}.`) +
                      (data.truncated
                          ? ` Only the soonest ${upcoming.length} are returned: narrow with days, plan_id or q.`
                          : '') +
                      ` ${DATA_NOTICE}`,
        };
    },
});
