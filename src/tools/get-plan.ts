import * as z from 'zod';

import { PLAN_STATUSES, PULL_OUTCOMES, SUBSCRIPTION_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { idInput } from './inputs.js';
import { capped, MAX_NESTED_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import { attemptOut, attemptOutput, planOut, planOutput } from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

export const getPlan = defineTool({
    name: 'get_plan',
    title: 'Read one plan',
    description:
        'Read one plan of the project in full: its terms, how many subscribers it has in ' +
        'each state, what it brings a month and collected so far, how its charges ended, ' +
        'the commonest reasons they failed, who is charged next, and its latest charge ' +
        'attempts. Use it when the merchant asks how a plan is doing or why its payments ' +
        'fail. Take the id from `list_plans`. For the subscribers themselves use ' +
        '`list_subscriptions` with this plan. Every amount comes with a display value: ' +
        'quote that one. Changes nothing.',
    inputSchema: z.strictObject({
        plan_id: idInput('The id of the plan, as `list_plans` returns it. Not its slug.'),
    }),
    outputSchema: z.object({
        plan: planOutput,
        subscribers_by_status: z
            .record(z.string(), z.number())
            .describe(
                `How many subscriptions are in each state (${SUBSCRIPTION_STATUSES.join(', ')}). ` +
                    'A state nobody is in is absent.',
            ),
        monthly: z
            .string()
            .describe('What the plan brings a month, in the smallest unit of the mint.'),
        monthly_display: z.string(),
        monthly_usd: z.string().nullable(),
        collected: z
            .string()
            .describe('Everything it collected, in the smallest unit of the mint.'),
        collected_display: z.string(),
        collected_usd: z.string(),
        unpriced_paid: z
            .number()
            .describe('Paid charges not priced in dollars: `collected_usd` is partial.'),
        outcomes: z
            .record(z.string(), z.number())
            .describe(
                `How its charges ended (${PULL_OUTCOMES.join(', ')}). REJECTED: refused on the ` +
                    'subscriber side. BLOCKED: on ours.',
            ),
        failures: z
            .array(
                z.object({ reason: z.string().describe('A short code: data.'), count: z.number() }),
            )
            .describe('Why charges failed, commonest first.'),
        upcoming: z
            .array(
                z.object({
                    subscriber: z.string(),
                    due_at: z.string(),
                    failed_pulls: z.number(),
                    retries: z.number(),
                }),
            )
            .describe(`Who is charged next, soonest first, ${MAX_NESTED_ITEMS} at most.`),
        next_pull: z
            .object({
                due_at: z.string(),
                amount: z.string(),
                amount_display: z.string(),
                manual: z
                    .boolean()
                    .describe('True: it waits for a retry by hand (`retry_charge`).'),
            })
            .nullable(),
        attempts: z
            .array(attemptOutput.extend({ subscription_id: z.string() }))
            .describe(`The latest charge attempts, newest first, ${MAX_NESTED_ITEMS} at most.`),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ plan_id }, { mesub, signal }) => {
        const detail = await mesub.plan(plan_id, signal);
        const { plan } = detail;
        const shown = (amount: string) => displayAmount(amount, plan.decimals, plan);
        const attempts = capped(detail.attempts, MAX_NESTED_ITEMS).kept;
        const subscribers = Object.values(detail.subscribers).reduce((sum, n) => sum + n, 0);

        return {
            data: {
                plan: planOut(plan),
                subscribers_by_status: detail.subscribers,
                monthly: detail.monthly,
                monthly_display: shown(detail.monthly),
                monthly_usd: detail.monthlyUsd,
                collected: detail.collected,
                collected_display: shown(detail.collected),
                collected_usd: detail.collectedUsd,
                unpriced_paid: detail.unpricedPaid,
                outcomes: detail.outcomes,
                failures: capped(detail.failures, MAX_NESTED_ITEMS).kept,
                upcoming: snake(capped(detail.upcoming, MAX_NESTED_ITEMS).kept),
                next_pull: detail.nextPull && {
                    due_at: detail.nextPull.dueAt,
                    amount: detail.nextPull.amount,
                    amount_display: shown(detail.nextPull.amount),
                    manual: detail.nextPull.manual,
                },
                attempts: attempts.map((attempt) => ({
                    ...attemptOut(attempt, plan.decimals, plan),
                    subscription_id: attempt.subscriptionId,
                })),
            },
            text:
                `The plan is ${known(plan.status, PLAN_STATUSES)}, with ${plural(subscribers, 'subscription')} and ` +
                `${plural(detail.outcomes.PAID ?? 0, 'paid charge')} out of ` +
                `${Object.values(detail.outcomes).reduce((sum, n) => sum + n, 0)}. ${DATA_NOTICE}`,
        };
    },
});
