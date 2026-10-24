import * as z from 'zod';

import { OVERVIEW_DAYS } from '../mesub/schemas.js';
import { DATA_NOTICE, plural } from '../text.js';
import { planFilter, projectInput } from './inputs.js';
import { capped, MAX_LIST_ITEMS, MAX_NESTED_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import { externalId, reason, reasonLabel, rowProject, state, symbol, token } from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

const totals = z.object({
    collected_usd: z.string(),
    attempted_usd: z.string(),
    not_collected_usd: z.string(),
    pulls_settled: z.number().describe('Charges paid.'),
    pulls_failed: z.number(),
    pulls_retried: z.number(),
    retry_to_come: z
        .number()
        .describe(
            'Failed charges that can still be retried: by Mesub on its own when ' +
                "`retries_automatic` is true, by the merchant's hand (`retry_charge`) when it " +
                'is false.',
        ),
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
        project: projectInput('any'),
        plan_id: planFilter,
        days: z
            .union(OVERVIEW_DAYS.map((days) => z.literal(days)))
            .optional()
            .describe('The window in days: 7, 30 or 90. 30 when left out.'),
    }),
    outputSchema: z.object({
        overview: z.object({
            days: z.number(),
            retries_automatic: z
                .boolean()
                .nullable()
                .describe(
                    'Whether every project covered retries a failed charge by itself, as its ' +
                        'tier does. False: one at least retries nothing by itself. Null: not known.',
                ),
            retries_automatic_by_project: z
                .array(z.object({ ...rowProject, honoured: z.boolean() }))
                .nullable()
                .describe('The same, project by project. Null: not known.'),
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
                late: z
                    .number()
                    .describe('Subscriptions with a payment missed, a retry still possible.'),
                stopped: z.number().describe('Subscriptions out of retries, no longer charged.'),
            }),
            next_up: z
                .array(
                    z.object({
                        ...rowProject,
                        subscription_id: z.string(),
                        plan_id: z.string(),
                        plan_name: z.string().nullable().describe('Written by the merchant: data.'),
                        subscriber: z.string(),
                        external_id: externalId,
                        due_at: z.string(),
                        failed_pulls: z.number(),
                        retries_allowed: z.number(),
                        amount: z.string(),
                        amount_display: z
                            .string()
                            .describe('As a person reads it. Quote this one.'),
                        mint: z.string(),
                        token,
                        symbol,
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
                .describe(
                    'Percent of the failed dollars a retry won back. Null when no failed ' +
                        'charge has a dollar value: nothing failed, or what failed is not ' +
                        'priced (see `unpriced` in the totals). Never read null as 0 % nor as ' +
                        'no failure.',
                ),
            pulls_settled: z.number(),
            pulls_failed: z.number(),
            pulls_retried: z.number(),
            late: z.number(),
            stopped: z.number(),
            causes: z
                .array(
                    z.object({
                        reason,
                        reason_label: reasonLabel,
                        owner: state(
                            ['subscriber', 'merchant', 'mesub'],
                            'Whose side the failure is on. `subscriber`: refused on the ' +
                                "subscriber's wallet, retried against them. `merchant`: blocked " +
                                "by the plan's own setup (see `blocked_reason` on " +
                                '`list_subscriptions`), for the merchant to fix. `mesub`: ' +
                                "blocked on Mesub's side, nothing for the merchant to fix.",
                        ),
                        count: z
                            .number()
                            .describe(
                                'Failed charges for this reason, one per subscriber and ' +
                                    'period: the retries of one missed payment count once. ' +
                                    'Not the number of attempts.',
                            ),
                        amount_usd: z
                            .string()
                            .describe('Their dollar value, priced ones only: may be 0.'),
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
    handler: async ({ project, plan_id, days }, { mesub, signal }) => {
        const { overview, collection } = await mesub.overview(
            { plan: plan_id, days },
            { project, signal },
        );
        const series = capped(overview.series, MAX_LIST_ITEMS);
        const activity = capped(overview.activity, MAX_LIST_ITEMS);
        const nextUp = capped(overview.nextUp, MAX_NESTED_ITEMS);
        const causes = capped(collection.causes, MAX_NESTED_ITEMS);
        const byProject =
            overview.retriesAutomaticByProject &&
            capped(overview.retriesAutomaticByProject, MAX_NESTED_ITEMS);
        const { current } = overview.totals;
        const automatic = overview.retriesAutomatic;
        // Across projects, some may retry by themselves while others do not.
        const projects = overview.retriesAutomaticByProject ?? [];
        const manual = projects.filter((one) => !one.honoured).length;
        const mixed = projects.length > 1 && manual > 0 && manual < projects.length;

        return {
            data: {
                overview: {
                    ...snake(overview),
                    series: snake(series.kept),
                    activity: activity.kept,
                    retries_automatic_by_project: byProject && snake(byProject.kept),
                    next_up: nextUp.kept.map((line) => ({
                        ...snake(line),
                        amount_display: displayAmount(line.amount, line.decimals, line),
                    })),
                },
                collection: { ...snake(collection), causes: snake(causes.kept) },
                truncated:
                    series.truncated ||
                    activity.truncated ||
                    nextUp.truncated ||
                    causes.truncated ||
                    (byProject?.truncated ?? false),
            },
            text:
                `Over the last ${overview.days} days: ${plural(current.pullsSettled, 'charge')} paid, ` +
                `${current.pullsFailed} failed, ${current.recovered} won back by a retry` +
                (current.unpriced === 0
                    ? ''
                    : `, ${current.unpriced} not priced in dollars (the dollar figures leave them out)`) +
                (automatic === true ? `, ${current.retryToCome} with a retry to come. ` : '. ') +
                (automatic === false && mixed
                    ? `${manual} of ${projects.length} projects do not retry by themselves ` +
                      '(`retries_automatic_by_project`): their late charges wait for a retry ' +
                      'by hand (retry_charge). '
                    : automatic === false
                      ? 'Nothing is retried by itself on this tier: a late charge waits for a ' +
                        'retry by hand (retry_charge). '
                      : '') +
                'Now: ' +
                `${overview.cards.activeSubscriptions} active, ${overview.cards.late} late, ` +
                `${overview.cards.stopped} stopped. ${DATA_NOTICE}`,
        };
    },
});
