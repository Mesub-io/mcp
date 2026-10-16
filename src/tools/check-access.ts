import * as z from 'zod';

import { ACCESS_STATUSES, PAYMENT_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { capped, MAX_LIST_ITEMS } from './limits.js';
import {
    blockedReason,
    blockedSince,
    blockInWords,
    closable,
    closableFrom,
    endReason,
    reason,
    reasonLabel,
    stopReason,
} from './shapes.js';
import { defineTool } from './tool.js';

const answerOutput = z.object({
    wallet: z.string().nullable().describe('The wallet that pays. Null: nothing on this plan.'),
    plan: z.string().describe('The slug of the plan.'),
    subscription_id: z
        .string()
        .nullable()
        .describe(
            'The subscription this answer is about, for `get_subscription` or `retry_charge`. ' +
                'Null: the customer has nothing on this plan.',
        ),
    access: z
        .boolean()
        .describe('Whether the customer may use the plan now: the only field a gate reads.'),
    status: z.string().describe('`none`: the customer has no subscription to the plan.'),
    paused: z.boolean(),
    end_reason: endReason(),
    late_reason: z
        .string()
        .nullable()
        .describe(
            'On `unpaid`, and on `stopped` for the payment it stopped on: why the last ' +
                'charge failed. `insufficient_balance`, `approval_revoked` or `authority_closed`.',
        ),
    stop_reason: stopReason(),
    closable,
    closable_from: closableFrom,
    payment_status: z.string().describe('`paid`, `late` or `none`.'),
    blocked_since: blockedSince(
        '`status` nor `payment_status`',
        '`next_charge_at`, or `next_retry_at`',
    ),
    blocked_reason: blockedReason,
    subscribed_since: z.string().nullable(),
    first_subscribed_at: z.string().nullable(),
    current_period_end: z.string().nullable(),
    cancelled_at: z.string().nullable(),
    access_until: z
        .string()
        .nullable()
        .describe(
            'When access ends unless a charge renews it. Null while `access` is false. ' +
                'Under a block (`blocked_since`), access is never true past it.',
        ),
    next_charge_at: z.string().nullable(),
    next_retry_at: z.string().nullable(),
    retry_deadline: z.string().nullable(),
    attempts: z
        .array(
            z.object({
                outcome: z.string(),
                reason: reason.nullable(),
                reason_label: reasonLabel,
                amount: z
                    .string()
                    .describe(
                        "Raw: in the smallest unit of the plan's token, with no display " +
                            'value here. Never quote it nor convert it: the price to quote ' +
                            'comes from `get_subscription` or `get_plan`.',
                    ),
                attempted_at: z.string(),
                signature: z.string().nullable(),
            }),
        )
        .optional()
        .describe('The last five charges, only when asked for. Their amounts are raw.'),
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
        'merchant asks "does this customer have access" or "why was this user locked out". ' +
        "Name the customer by exactly one of their wallet, the merchant's own id for them, " +
        'or their email. With a plan slug it answers for that plan; without one, for every ' +
        'plan of the project the customer has. No subscription is a normal answer ' +
        '(`access: false`, status `none`), not an error. Gate on `access` alone; ' +
        '`stop_reason` and `end_reason` say why it stopped or ended, `closable` whether the ' +
        'subscriber can now close it on Solana to get its deposit back. An answer with ' +
        "`blocked_since` set is a charge blocked by the plan's setup or by Mesub, not a late " +
        'subscriber: `blocked_reason` says what to fix. States are lower case here ' +
        '(`unpaid`), upper case in the other tools (`UNPAID`). Charge amounts are raw, in ' +
        "the token's smallest unit: quote prices from `get_subscription` or `get_plan`. To " +
        'browse subscribers use `list_subscriptions`. Changes nothing.',
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
                .describe(
                    "The merchant's own id for the customer, as given when they subscribed. A " +
                        'bare name the merchant uses for a customer, such as `ben`, is usually ' +
                        'this id: try it before asking who they mean.',
                ),
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
                    `${known(answer.status, ACCESS_STATUSES)}, payment ` +
                    `${known(answer.payment_status, PAYMENT_STATUSES)}` +
                    `${answer.paused ? ', paused' : ''}.${blockInWords(answer)} ${DATA_NOTICE}`,
            };
        }

        const list = await mesub.accessList(customer, signal);
        const { kept, truncated } = capped(list.plans, MAX_LIST_ITEMS);
        const blocked = list.plans.filter((answer) => answer.blocked_since !== null).length;
        return {
            data: { plans: kept, truncated, revalidate_after: list.revalidate_after },
            text:
                list.plans.length === 0
                    ? 'This customer has no subscription to any plan of the project: no access.'
                    : `The customer has ${plural(list.plans.length, 'plan')}, ` +
                      `${list.plans.filter((answer) => answer.access).length} with access` +
                      `${blocked === 0 ? '' : `, ${blocked} with charges blocked`}. ` +
                      DATA_NOTICE,
        };
    },
});
