import * as z from 'zod';

import { PLAN_STATUSES, PULL_OUTCOMES, SUBSCRIPTION_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { idInput, projectInput } from './inputs.js';
import { capped, MAX_NESTED_ITEMS } from './limits.js';
import { displayAmount } from './money.js';
import {
    attemptOut,
    attemptOutput,
    externalId,
    planOut,
    planOutput,
    reason,
    reasonLabel,
    rowProject,
    signUrl,
    toSignUrl,
} from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

/** The states a plan counts its subscribers in: never a checkout unsigned, nor a row replaced. */
const COUNTED_STATUSES = SUBSCRIPTION_STATUSES.filter(
    (status) => !['PENDING', 'EXPIRED', 'SUPERSEDED'].includes(status),
);

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
        project: projectInput('any'),
    }),
    outputSchema: z.object({
        plan: planOutput.extend({ ...rowProject, sign_url: signUrl, to_sign_url: toSignUrl }),
        subscribers_by_status: z
            .record(z.string(), z.number())
            .describe(
                `How many subscriptions are in each state (${COUNTED_STATUSES.join(', ')}). ` +
                    'A cancellation past its end counts as ENDED. A state nobody is in is ' +
                    'absent. Checkouts not signed and rows a comeback replaced are not counted.',
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
                    "subscriber side. BLOCKED: blocked by the plan's own setup, for the merchant " +
                    "to fix, or on Mesub's side: `failures` gives the reason.",
            ),
        failures: z
            .array(z.object({ reason, reason_label: reasonLabel, count: z.number() }))
            .describe('Why charges failed, commonest first.'),
        upcoming: z
            .array(
                z.object({
                    subscriber: z.string(),
                    external_id: externalId,
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
            .array(attemptOutput.extend({ subscription_id: z.string(), external_id: externalId }))
            .describe(`The latest charge attempts, newest first, ${MAX_NESTED_ITEMS} at most.`),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ plan_id, project }, { mesub, signal }) => {
        const detail = await mesub.plan(plan_id, { project, signal });
        const { plan } = detail;
        const shown = (amount: string) => displayAmount(amount, plan.decimals, plan);
        const attempts = capped(detail.attempts, MAX_NESTED_ITEMS).kept;
        const subscribers = Object.values(detail.subscribers).reduce((sum, n) => sum + n, 0);

        return {
            data: {
                plan: {
                    ...planOut(plan),
                    project_id: plan.projectId,
                    project_name: plan.projectName,
                    sign_url: plan.signUrl,
                    to_sign_url: plan.toSignUrl,
                },
                subscribers_by_status: detail.subscribers,
                monthly: detail.monthly,
                monthly_display: shown(detail.monthly),
                monthly_usd: detail.monthlyUsd,
                collected: detail.collected,
                collected_display: shown(detail.collected),
                collected_usd: detail.collectedUsd,
                unpriced_paid: detail.unpricedPaid,
                outcomes: detail.outcomes,
                failures: snake(capped(detail.failures, MAX_NESTED_ITEMS).kept),
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
                    external_id: attempt.externalId,
                })),
            },
            text:
                `The plan is ${known(plan.status, PLAN_STATUSES)}, with ${plural(subscribers, 'subscription')} and ` +
                `${plural(detail.outcomes.PAID ?? 0, 'paid charge')} out of ` +
                `${Object.values(detail.outcomes).reduce((sum, n) => sum + n, 0)}. ` +
                // The address stands alone, so that nothing after it is read as part of it.
                (plan.signUrl === null
                    ? ''
                    : `It is not on chain: the merchant reviews and signs it at ${plan.signUrl} . `) +
                DATA_NOTICE,
        };
    },
});
