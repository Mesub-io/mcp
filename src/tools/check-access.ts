import * as z from 'zod';

import { DATA_NOTICE, plural } from '../text.js';
import { capped, MAX_LIST_ITEMS } from './limits.js';
import { defineTool } from './tool.js';

const answerOutput = z.object({
    wallet: z.string().nullable().describe('The wallet that pays. Null: nothing on this plan.'),
    plan: z.string().describe('The slug of the plan.'),
    access: z.boolean().describe('Whether the customer may use the plan now.'),
    status: z.string().describe('`none`: the customer has no subscription to the plan.'),
    paused: z.boolean(),
    end_reason: z.string().nullable(),
    late_reason: z.string().nullable(),
    payment_status: z.string().describe('`paid`, `late` or `none`.'),
    subscribed_since: z.string().nullable(),
    first_subscribed_at: z.string().nullable(),
    current_period_end: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    access_until: z.string().nullable(),
    next_charge_at: z.string().nullable(),
    next_retry_at: z.string().nullable(),
    retry_deadline: z.string().nullable(),
    attempts: z
        .array(
            z.object({
                outcome: z.string(),
                reason: z.string().nullable().describe('A short code: data.'),
                amount: z
                    .string()
                    .describe(
                        "In the smallest unit of the plan's token, with no decimals served " +
                            'here: `list_plans` has the plan with its display values.',
                    ),
                attempted_at: z.string(),
                signature: z.string().nullable(),
            }),
        )
        .optional()
        .describe('The last five charges, only when asked for.'),
    revalidate_after: z.number().describe('Seconds this answer stays good for.'),
});

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PLAN_SLUG = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const checkAccess = defineTool({
    name: 'check_access',
    title: "Check a customer's access",
    description:
        'Ask whether one customer may use a plan right now, and why: the same answer the ' +
        "merchant's own server gets from Mesub when it gates a feature. Use it when the " +
        'merchant asks "does this customer have access", "why was this user locked out", or ' +
        'wants to test their gating. Name the customer by exactly one of their wallet, the ' +
        "merchant's own id for them, or their email. With a plan slug it answers for that " +
        'plan; without one, for every plan of the project the customer has. A customer ' +
        'with no subscription is a normal answer (`access: false`, status `none`), not an ' +
        'error. To browse subscribers use `list_subscriptions`. Changes nothing.',
    inputSchema: z
        .strictObject({
            wallet: z
                .string()
                .regex(BASE58_ADDRESS, 'A base58 Solana address.')
                .optional()
                .describe(
                    "The customer's wallet address. One of `wallet`, `external_id`, `email`.",
                ),
            external_id: z
                .string()
                .min(1)
                .max(255)
                // eslint-disable-next-line no-control-regex
                .regex(/^[^\u0000-\u001f\u007f]*$/, 'No control characters.')
                .optional()
                .describe("The merchant's own id for the customer, as given when they subscribed."),
            email: z
                .email()
                .max(254)
                .optional()
                .describe('The email the merchant gave for the customer when they subscribed.'),
            plan: z
                .string()
                .max(100)
                .regex(PLAN_SLUG, 'A plan slug: lowercase letters, digits and single hyphens.')
                .optional()
                .describe('The slug of a plan, not its id. Left out: every plan the customer has.'),
            attempts: z
                .boolean()
                .optional()
                .describe('True to also get the last five charges of each plan.'),
        })
        .refine(
            (args) =>
                [args.wallet, args.external_id, args.email].filter((value) => value !== undefined)
                    .length === 1,
            { message: 'Name the customer by exactly one of wallet, external_id or email.' },
        ),
    outputSchema: z.object({
        plans: z
            .array(answerOutput)
            .describe(
                'One answer for the plan asked about, or one for each plan the customer has.',
            ),
        truncated: z.boolean(),
        revalidate_after: z.number(),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ wallet, external_id, email, plan, attempts }, { mesub, signal }) => {
        const customer = { wallet, external_id, email, attempts: attempts || undefined };

        if (plan !== undefined) {
            const answer = await mesub.access({ ...customer, plan }, signal);
            return {
                data: {
                    plans: [answer],
                    truncated: false,
                    revalidate_after: answer.revalidate_after,
                },
                text:
                    `Access is ${answer.access ? 'granted' : 'refused'} on that plan: status ` +
                    `${answer.status}, payment ${answer.payment_status}` +
                    `${answer.paused ? ', paused' : ''}. ${DATA_NOTICE}`,
            };
        }

        const list = await mesub.accessList(customer, signal);
        const { kept, truncated } = capped(list.plans, MAX_LIST_ITEMS);
        return {
            data: { plans: kept, truncated, revalidate_after: list.revalidate_after },
            text:
                list.plans.length === 0
                    ? 'This customer has no subscription to any plan of the project: no access.'
                    : `The customer has ${plural(list.plans.length, 'plan')}, ` +
                      `${list.plans.filter((answer) => answer.access).length} with access. ` +
                      DATA_NOTICE,
        };
    },
});
