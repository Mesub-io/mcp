import * as z from 'zod';

import { SUBSCRIPTION_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { idInput } from './inputs.js';
import { subscriptionOut, subscriptionOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const retryCharge = defineTool({
    name: 'retry_charge',
    title: 'Retry a failed charge',
    description:
        'Charge a subscriber who is late on a payment again, now. This acts on a ' +
        "subscriber's money: when it succeeds, the plan's amount leaves their wallet for " +
        "the merchant's, on chain, and cannot be taken back from here. Ask the merchant, " +
        'naming the subscription, before every call, and never call it in a loop over a ' +
        'list. It works only on a subscription that is behind on its payment (status ' +
        'UNPAID) and not paused. Its `retry_available_at` says when a retry is allowed, ' +
        'and a row of `list_subscriptions` is enough to know it; `get_subscription` adds the ' +
        'price to quote, the charges it ran and why they failed. ' +
        'Mesub limits retries by hand: a wait between two, which the refusal states ' +
        '("Try again in N minutes"), and on the Free tier three per missed period. A ' +
        'refusal means nothing was charged. The charge is queued, not settled: read ' +
        '`get_subscription` afterwards for its outcome. To change how failed charges are ' +
        'retried automatically use `update_retry_policy`. It cannot charge a subscriber ' +
        "who is not late, nor any other amount than the plan's.",
    inputSchema: z.strictObject({
        subscription_id: idInput(
            'The id of the late subscription, as `list_subscriptions` returns it.',
        ),
    }),
    outputSchema: z.object({ subscription: subscriptionOutput }),
    annotations: {
        readOnlyHint: false,
        // It moves a subscriber's money, and a transfer on chain is not undone.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    handler: async ({ subscription_id }, { mesub, signal }) => {
        const subscription = subscriptionOut(await mesub.retryCharge(subscription_id, signal));
        return {
            data: { subscription },
            text:
                'The charge was queued for a new try: it is not settled yet. The subscription ' +
                `is ${known(subscription.status, SUBSCRIPTION_STATUSES)}, with ` +
                `${plural(subscription.failed_pulls, 'failed charge')} on the current period. ` +
                `Read it again with get_subscription for the outcome. ${DATA_NOTICE}`,
        };
    },
});
