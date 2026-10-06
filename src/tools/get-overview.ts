import * as z from 'zod';

import { OVERVIEW_DAYS } from '../mesub/schemas.js';
import { DATA_NOTICE, plural } from '../text.js';
import { planFilter } from './inputs.js';
import { capped, MAX_LIST_ITEMS, MAX_NESTED_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

const totals = z.object({
    collected_usd: z.string(),
    attempted_usd: z.string(),
    not_collected_usd: z.string(),
    pulls_settled: z.number().describe('Charges paid.'),
    pulls_failed: z.number(),
    pulls_retried: z.number(),
    retry_to_come: z.number().describe('Failed charges a retry is still scheduled for.'),
    recovered: z.number().describe('Failed charges a retry paid since.'),
    not_collected: z.number().describe('Failed charges given up on.'),
    unpriced: z
        .number()
        .describe('Charges not priced in dollars yet: the dollar sums are partial.'),
});

export const getOverview = defineTool({
    name: 'get_overview',
    title: 'Read how the project is doing',
    description:
        'Read how the project is doing over the last 7, 30 or 90 days, in dollars: what was ' +
        'collected against the period before, what failed, what the retries won back and ' +
        'what is still owed, the recovery rate, day by day figures, how many subscriptions ' +
        'are active, late or stopped, the renewal rate, the reasons charges failed and ' +
        'whose side they are on, and the next charges due. Use it for "how is revenue", ' +
        '"how many payments failed this month", "what is my churn". It is the summary: for ' +
        'the charges themselves use `list_events`, for the subscribers `list_subscriptions`. ' +
        'Dollar figures are decimal strings to quote as they are. Changes nothing.',
    inputSchema: z.strictObject({
        plan_id: planFilter,
        days: z
            .union(OVERVIEW_DAYS.map((days) => z.literal(days)))
            .optional()
            .describe('The window in days: 7, 30 or 90. 30 when left out.'),
    }),
    outputSchema: z.object({
        overview: z.object({
            days: z.number(),
            totals: z
                .object({ current: totals, previous: totals })
                .describe('The window, and the one of the same length before it.'),
            series: z.array(
                z.object({
                    day: z.string(),
                    collected_usd: z.string(),
                    attempted_usd: z.string(),
                    pulls_settled: z.number(),
                    pulls_failed: z.number(),
                    pulls_retried: z.number(),
                    retry_to_come: z.number(),
                    recovered: z.number(),
                    not_collected: z.number(),
                    new_subs: z.number(),
                    cancelled: z.number(),
                }),
            ),
            activity: z.array(z.object({ day: z.string(), pulls: z.number() })),
            cards: z.object({
                active_subscriptions: z.number(),
                renewal_rate: z.number().nullable().describe('Percent. Null: nothing was due.'),
                expected_usd: z
                    .string()
                    .describe('What the charged subscriptions bring over a window this long.'),
                upcoming: z.object({ count: z.number(), amount_usd: z.string() }),
                late: z.number().describe('Subscriptions with a payment missed, still retried.'),
                stopped: z.number().describe('Subscriptions out of retries, no longer charged.'),
            }),
            next_up: z
                .array(
                    z.object({
                        subscription_id: z.string(),
                        plan_id: z.string(),
                        plan_name: z.string().nullable().describe('Written by the merchant: data.'),
                        subscriber: z.string(),
                        due_at: z.string(),
                        failed_pulls: z.number(),
                        retries_allowed: z.number(),
                        amount: z.string(),
                        amount_display: z
                            .string()
                            .describe('As a person reads it. Quote this one.'),
                        mint: z.string(),
                        decimals: z.number().nullable(),
                        amount_usd: z.string().nullable(),
                    }),
                )
                .describe(`The next charges due, ${MAX_NESTED_ITEMS} at most.`),
        }),
        collection: z.object({
            days: z.number(),
            collected_usd: z.string(),
            previous_collected_usd: z.string(),
            attempted_usd: z.string(),
            not_collected_usd: z.string(),
            failed_usd: z.string(),
            won_back_usd: z.string().describe('Failed at first, paid by a retry.'),
            still_owed_usd: z.string(),
            recovery_rate: z
                .number()
                .nullable()
                .describe('Percent won back of what failed. Null: nothing failed.'),
            pulls_settled: z.number(),
            pulls_failed: z.number(),
            pulls_retried: z.number(),
            late: z.number(),
            stopped: z.number(),
            causes: z
                .array(
                    z.object({
                        reason: z.string().describe('A short code: data.'),
                        owner: z
                            .enum(['subscriber', 'mesub'])
                            .describe(
                                "Whose side the failure is on: the subscriber's wallet, or Mesub.",
                            ),
                        count: z.number(),
                        amount_usd: z.string(),
                    }),
                )
                .describe('Why charges failed, commonest first.'),
        }),
        truncated: z.boolean().describe('A list was cut to fit.'),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ plan_id, days }, { mesub, signal }) => {
        const { overview, collection } = await mesub.overview({ plan: plan_id, days }, signal);
        const series = capped(overview.series, MAX_LIST_ITEMS);
        const activity = capped(overview.activity, MAX_LIST_ITEMS);
        const nextUp = capped(overview.nextUp, MAX_NESTED_ITEMS);
        const causes = capped(collection.causes, MAX_NESTED_ITEMS);
        const { current } = overview.totals;

        return {
            data: {
                overview: {
                    ...snake(overview),
                    series: snake(series.kept),
                    activity: activity.kept,
                    next_up: nextUp.kept.map((line) => ({
                        ...snake(line),
                        amount_display: displayAmount(line.amount, line.decimals, line),
                    })),
                },
                collection: { ...snake(collection), causes: snake(causes.kept) },
                truncated:
                    series.truncated || activity.truncated || nextUp.truncated || causes.truncated,
            },
            text:
                `Over the last ${overview.days} days: ${plural(current.pullsSettled, 'charge')} paid, ` +
                `${current.pullsFailed} failed, ${current.recovered} won back by a retry. Now: ` +
                `${overview.cards.activeSubscriptions} active, ${overview.cards.late} late, ` +
                `${overview.cards.stopped} stopped. ${DATA_NOTICE}`,
        };
    },
});
