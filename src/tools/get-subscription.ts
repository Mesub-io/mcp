import * as z from 'zod';

import { SUBSCRIPTION_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { idInput, projectInput } from './inputs.js';
import { blockInWords, subscriptionOut, subscriptionOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const getSubscription = defineTool({
    name: 'get_subscription',
    title: 'Read one subscription',
    description:
        'Read one subscription to a plan of the project: its state, whether it has access, ' +
        'when it is charged next, what it paid in all, and every charge it ran, newest ' +
        'first, each failed one with its reason. Use it to explain why a subscriber is late ' +
        'or lost access, or for the price to quote and the failures to name before ' +
        '`retry_charge`. With `blocked_since` set, its charges are blocked by the ' +
        "plan's setup or by Mesub, not by a late subscriber: `blocked_reason` says what " +
        'to fix. A stopped one says why in `stop_reason`, an ended one in `end_reason`, and ' +
        '`closable` says whether its subscriber can close it now. Take the id from ' +
        '`list_subscriptions` or `check_access`. It reads the ' +
        "merchant's side: it cannot cancel, resume or change a subscription, which only " +
        'the subscriber can. Every amount comes with a display value: quote that one. ' +
        'Changes nothing.',
    inputSchema: z.strictObject({
        subscription_id: idInput('The id of the subscription, as `list_subscriptions` returns it.'),
        project: projectInput('any'),
    }),
    outputSchema: z.object({ subscription: subscriptionOutput }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ subscription_id, project }, { mesub, signal }) => {
        const subscription = subscriptionOut(
            await mesub.subscription(subscription_id, { project, signal }),
        );
        return {
            data: { subscription },
            text:
                `The subscription is ${known(subscription.status, SUBSCRIPTION_STATUSES)}, with ` +
                `${plural(subscription.failed_pulls, 'failed charge')} on the current period.` +
                `${blockInWords(subscription)} ` +
                `${plural(subscription.attempts.length, 'charge')} returned` +
                (subscription.attempts_truncated ? ', older ones left out. ' : '. ') +
                DATA_NOTICE,
        };
    },
});
