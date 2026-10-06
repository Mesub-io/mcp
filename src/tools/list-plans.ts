import * as z from 'zod';

import { DATA_NOTICE, plural, tally } from '../text.js';
import { capped, fit, MAX_LIST_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import { planOut, planOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const listPlans = defineTool({
    name: 'list_plans',
    title: 'List the plans',
    description:
        'List the subscription plans of the project, newest first, whatever their state: ' +
        'what each one charges and how often, in which token, how many subscribers it has ' +
        'and what it collected this period. Use it to find a plan, its id or its slug, or to ' +
        'compare plans. For one plan with its failed charges and latest attempts use ' +
        '`get_plan` with its id. It does not create or edit a plan. Every amount comes with ' +
        'a display value such as "9.99 USDC": quote that one, never convert the raw amount ' +
        'yourself. Changes nothing.',
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
        plans: z.array(
            planOutput.extend({
                subscribers: z.number(),
                collected_this_period: z
                    .string()
                    .describe(
                        'Paid charges of the current period, in the smallest unit of the mint.',
                    ),
                collected_this_period_display: z
                    .string()
                    .describe('The same, as a person reads it.'),
                collected_this_period_usd: z.string(),
                unpriced_this_period: z
                    .number()
                    .describe('Paid charges not priced in dollars yet: the dollar sum is partial.'),
            }),
        ),
        total: z.number().describe('How many plans the project has.'),
        truncated: z.boolean().describe('Some were left out of `plans`: the oldest ones.'),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async (_args, { mesub, signal }) => {
        const all = await mesub.plans(signal);
        const { kept, truncated } = capped(all, MAX_LIST_ITEMS);
        const plans = kept.map((plan) => ({
            ...planOut(plan),
            subscribers: plan.subscribers,
            collected_this_period: plan.collectedThisPeriod,
            collected_this_period_display: displayAmount(
                plan.collectedThisPeriod,
                plan.decimals,
                plan,
            ),
            collected_this_period_usd: plan.collectedThisPeriodUsd,
            unpriced_this_period: plan.unpricedThisPeriod,
        }));
        const data = { plans, total: all.length, truncated };
        data.truncated = fit(data, plans) || truncated;

        return {
            data,
            text:
                all.length === 0
                    ? 'The project has no plan yet.'
                    : `${plural(all.length, 'plan')}: ${tally(all.map((plan) => plan.status))}.` +
                      (data.truncated ? ` Only the newest ${plans.length} are returned.` : '') +
                      ` ${DATA_NOTICE}`,
        };
    },
});
