import * as z from 'zod';

import { SUBSCRIPTION_BUCKETS } from '../mesub/schemas.js';
import { DATA_NOTICE, plural } from '../text.js';
import { MAX_DAYS, planFilter, searchInput } from './inputs.js';
import { subscriptionRowOut, subscriptionRowOutput } from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE = 10_000;

export const listSubscriptions = defineTool({
    name: 'list_subscriptions',
    title: 'List the subscriptions',
    description:
        "List the subscriptions to the project's plans, the most urgent first, a page at a " +
        'time: who pays for which plan, where each one stands, whether it has access and ' +
        'when it is charged next. Use it to find the subscribers who are late on a payment ' +
        '(`status: "late"`), those Mesub stopped charging (`"stopped"`), those who ' +
        'cancelled, or the new ones, and to look a subscriber up by part of their wallet. ' +
        'It also returns how many subscriptions are in each of those groups and what they ' +
        'bring a month. For one subscription with every charge it ran use ' +
        '`get_subscription`. To ask whether one customer has access use `check_access`. ' +
        'Changes nothing.',
    inputSchema: z.strictObject({
        plan_id: planFilter,
        status: z
            .enum(SUBSCRIPTION_BUCKETS)
            .optional()
            .describe(
                'Which ones: `all` (when left out), `active`, `late` (a payment missed, still ' +
                    'retried), `stopped` (out of retries, no longer charged), `cancelled`, or ' +
                    '`new` (subscribed within `days`).',
            ),
        q: searchInput('Part of a wallet address, or a subscription id.').optional(),
        days: z
            .number()
            .int()
            .min(1)
            .max(MAX_DAYS)
            .optional()
            .describe('How many days back `new` reaches. 30 when left out.'),
        page: z.number().int().min(1).max(MAX_PAGE).default(1).describe('The page, from 1.'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_PAGE_SIZE)
            .default(DEFAULT_PAGE_SIZE)
            .describe(`Subscriptions a page, ${MAX_PAGE_SIZE} at most.`),
    }),
    outputSchema: z.object({
        subscriptions: z.array(subscriptionRowOutput),
        page: z.number(),
        limit: z.number(),
        total: z.number().describe('Subscriptions matching, over every page.'),
        has_more: z.boolean(),
        next_page: z
            .number()
            .nullable()
            .describe('The `page` to ask for next. Null: this is the last.'),
        counts: z
            .object({
                all: z.number(),
                active: z.number(),
                late: z.number(),
                stopped: z.number(),
                cancelled: z.number(),
                new: z.number(),
            })
            .describe('How many subscriptions each `status` holds, whatever was asked.'),
        monthly_usd: z
            .string()
            .describe('What the charged subscriptions bring a month, in dollars.'),
        late_monthly_usd: z.string().describe('The part of it that is late.'),
        stopped_monthly_usd: z
            .string()
            .describe('What the stopped ones brought a month, outside it.'),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ plan_id, status, q, days, page, limit }, { mesub, signal }) => {
        const found = await mesub.subscriptions(
            { plan: plan_id, status, q, days, page, limit },
            signal,
        );
        const more = found.page * found.limit < found.total;

        return {
            data: {
                subscriptions: found.rows.map(subscriptionRowOut),
                page: found.page,
                limit: found.limit,
                total: found.total,
                has_more: more,
                next_page: more ? found.page + 1 : null,
                counts: found.counts,
                ...snake({
                    monthlyUsd: found.monthlyUsd,
                    lateMonthlyUsd: found.lateMonthlyUsd,
                    stoppedMonthlyUsd: found.stoppedMonthlyUsd,
                }),
            },
            text:
                `${found.rows.length} of ${plural(found.total, 'subscription')}, page ${found.page}. ` +
                (more ? `More exist: call again with page ${found.page + 1}.` : 'No more pages.') +
                ` In the project: ${found.counts.late} late, ${found.counts.stopped} stopped. ` +
                DATA_NOTICE,
        };
    },
});
