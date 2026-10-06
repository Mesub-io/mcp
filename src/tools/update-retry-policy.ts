import * as z from 'zod';

import { DATA_NOTICE } from '../text.js';
import { idInput } from './inputs.js';
import { planOut, planOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const MAX_RETRY_ATTEMPTS = 10;
export const MIN_RETRY_DELAY_MINUTES = 15;
/** A year: past any period a plan has. The API holds the policy to the plan's own period. */
export const MAX_RETRY_DELAY_MINUTES = 525_600;

export const updateRetryPolicy = defineTool({
    name: 'update_retry_policy',
    title: "Change a plan's retry policy",
    description:
        'Set how many times a failed charge is retried on one plan and how long Mesub waits ' +
        'between two tries, or clear the plan back to the built in policy by sending ' +
        'neither value. It replaces the policy the plan has, and applies to every subscriber ' +
        'of the plan from their next failed charge: it changes when their wallets are ' +
        'charged again, so say what will change and ask the merchant before calling it. ' +
        'Send both values or neither. Refused when the retries would not fit inside one ' +
        'period of the plan, and on a tier that does not retry (clearing is always ' +
        'allowed). Nothing is signed and nothing goes on chain. It changes nothing else of ' +
        'the plan: not its price, its end date, its receiver nor its state. To charge one ' +
        'late subscriber now use `retry_charge`; for a new plan, `prepare_plan`. Returns ' +
        'the plan.',
    inputSchema: z
        .strictObject({
            plan_id: idInput('The id of the plan, as `list_plans` returns it.'),
            retry_attempts: z
                .number()
                .int()
                .min(1)
                .max(MAX_RETRY_ATTEMPTS)
                .optional()
                .describe(
                    `How many retries a failed charge gets, 1 to ${MAX_RETRY_ATTEMPTS}. With ` +
                        '`retry_delay_minutes`, or left out with it.',
                ),
            retry_delay_minutes: z
                .number()
                .int()
                .min(MIN_RETRY_DELAY_MINUTES)
                .max(MAX_RETRY_DELAY_MINUTES)
                .optional()
                .describe(
                    `Minutes between two tries, ${MIN_RETRY_DELAY_MINUTES} at least. With ` +
                        '`retry_attempts`, or left out with it.',
                ),
        })
        .refine(
            (args) =>
                (args.retry_attempts === undefined) === (args.retry_delay_minutes === undefined),
            {
                message:
                    'Send both retry_attempts and retry_delay_minutes, or neither to clear the policy.',
            },
        ),
    outputSchema: z.object({ plan: planOutput }),
    annotations: {
        readOnlyHint: false,
        // The policy the plan had is overwritten, and with it when wallets are charged again.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ plan_id, retry_attempts, retry_delay_minutes }, { mesub, signal }) => {
        const plan = await mesub.updateRetryPolicy(
            plan_id,
            retry_attempts === undefined || retry_delay_minutes === undefined
                ? {}
                : { retryAttempts: retry_attempts, retryDelayMinutes: retry_delay_minutes },
            signal,
        );
        const policy =
            plan.retryAttempts === null
                ? 'the built in policy'
                : `${plan.retryAttempts} retries, ${plan.retryDelayMinutes} minutes apart`;

        return {
            data: { plan: planOut(plan) },
            text:
                `The plan now has ${policy}.` +
                (plan.retryPolicy.honoured
                    ? ''
                    : " The project's tier does not retry failed charges: the policy is kept and not applied.") +
                ` ${DATA_NOTICE}`,
        };
    },
});
