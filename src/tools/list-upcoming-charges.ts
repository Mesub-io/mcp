import * as z from 'zod';

import { UPCOMING_KINDS } from '../mesub/schemas.js';
import { DATA_NOTICE, plural, tally } from '../text.js';
import { MAX_DAYS, planFilter, searchInput } from './inputs.js';
import { capped, fit, MAX_LIST_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import { group } from './list-events.js';
import { state } from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

export const listUpcomingCharges = defineTool({
    name: 'list_upcoming_charges',
    title: 'List the upcoming charges',
    description:
        'List what is scheduled on the project in the coming days, soonest first: the next ' +
        'charges, the retries of failed ones with their number, and access running out ' +
        'after a cancellation. A charge Mesub already expects to fail is flagged ' +
        '(`renewal_issue`): the wallet holds too little, or the approval to charge it is ' +
        'gone. Use it for "what is due this week", "which renewals are at risk" or "how ' +
        'much is expected". For what already happened use `list_events`. It schedules and ' +
        'charges nothing. Every amount comes with a display value: quote that one.',
    inputSchema: z.strictObject({
        plan_id: planFilter,
        days: z
            .number()
            .int()
            .min(1)
            .max(MAX_DAYS)
            .optional()
            .describe('How many days ahead to look. 30 when left out.'),
        group,
        q: searchInput('Part of a wallet address, or a subscription id.').optional(),
    }),
    outputSchema: z.object({
        upcoming: z.array(
            z.object({
                subscription_id: z.string(),
                subscriber: z.string(),
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
                decimals: z.number().nullable(),
                amount_usd: z.string().nullable(),
                renewal_issue: state(
                    ['balance', 'authority'],
                    'At risk. `balance`: the wallet holds too little. `authority`: Mesub ' +
                        'may no longer move its tokens. Null: no issue found, or not checked.',
                ).nullable(),
                renewal_checked_at: z.string().nullable(),
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
    handler: async ({ plan_id, days, group: only, q }, { mesub, signal }) => {
        const lines = await mesub.upcoming({ plan: plan_id, days, group: only, q }, signal);
        const { kept, truncated } = capped(lines, MAX_LIST_ITEMS);
        const upcoming = kept.map((line) => ({
            ...snake(line),
            amount_display: displayAmount(line.amount, line.decimals, line),
        }));
        const data = { upcoming, total: lines.length, truncated };
        data.truncated = fit(data, upcoming) || truncated;
        const atRisk = lines.filter((line) => line.renewalIssue !== null).length;

        return {
            data,
            text:
                lines.length === 0
                    ? 'Nothing is scheduled in that window.'
                    : `${plural(lines.length, 'line')} scheduled: ${tally(
                          lines.map((line) => line.kind),
                          UPCOMING_KINDS,
                      )}. ` +
                      `${plural(atRisk, 'charge')} expected to fail.` +
                      (data.truncated
                          ? ` Only the soonest ${upcoming.length} are returned: narrow with days, plan_id or q.`
                          : '') +
                      ` ${DATA_NOTICE}`,
        };
    },
});
