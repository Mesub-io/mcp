import * as z from 'zod';

import { SUBSCRIPTION_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { idInput } from './inputs.js';
import { subscriptionOut, subscriptionOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const getSubscription = defineTool({
    name: 'get_subscription',
    title: 'Read one subscription',
    description:
        'Read one subscription to a plan of the project: its state, whether it has access, ' +
        'when it is charged next, what it paid in all, and every charge it ran, newest ' +
        'first, each failed one with its reason. Use it to explain why a subscriber is late ' +
        'or lost access, or to see whether a retry is possible (`retry_available_at`) ' +
        'before `retry_charge`. Take the id from `list_subscriptions`. It reads the ' +
        "merchant's side: it cannot cancel, resume or change a subscription, which only " +
        'the subscriber can. Every amount comes with a display value: quote that one. ' +
        'Changes nothing.',
    inputSchema: z.strictObject({
        subscription_id: idInput('The id of the subscription, as `list_subscriptions` returns it.'),
    }),
    outputSchema: z.object({ subscription: subscriptionOutput }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ subscription_id }, { mesub, signal }) => {
        const subscription = subscriptionOut(await mesub.subscription(subscription_id, signal));
        return {
            data: { subscription },
            text:
                `The subscription is ${known(subscription.status, SUBSCRIPTION_STATUSES)}, with ` +
                `${plural(subscription.failed_pulls, 'failed charge')} on the current period. ` +
                `${plural(subscription.attempts.length, 'charge')} returned` +
                (subscription.attempts_truncated ? ', older ones left out. ' : '. ') +
                DATA_NOTICE,
        };
    },
});
