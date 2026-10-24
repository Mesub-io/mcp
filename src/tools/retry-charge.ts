import * as z from 'zod';

import { SUBSCRIPTION_STATUSES } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { idInput, projectInput } from './inputs.js';
import {
    actedOn,
    actedOnOutput,
    blockInWords,
    inProject,
    subscriptionOut,
    subscriptionOutput,
} from './shapes.js';
import { defineTool } from './tool.js';

export const retryCharge = defineTool({
    name: 'retry_charge',
    title: 'Retry a failed charge',
    description:
        'Charge a subscriber who is late on a payment again, now. This acts on a ' +
        "subscriber's money: when it succeeds, the plan's amount leaves their wallet for " +
        "the merchant's, on chain, and cannot be taken back from here. Ask the merchant, " +
        'naming the subscription, before every call, and never call it in a loop over a ' +
        'list. Only on an UNPAID one, not paused. Its `retry_available_at` ' +
        'says when a retry is allowed, and a row of `list_subscriptions` is enough to know ' +
        'it; `get_subscription` adds the price to quote, the charges run and why they ' +
        'failed. Check `late_reason` first: on APPROVAL_REVOKED or AUTHORITY_CLOSED no ' +
        'retry can succeed, so offer none. Mesub refuses, spending no retry, one that ' +
        'cannot succeed or a wallet short of funds. Retries by hand are limited: a ' +
        'wait between two, and three per missed period on Free. A refusal ' +
        'charges nothing. The charge is queued, not settled: read ' +
        '`get_subscription` afterwards for its outcome. Automatic retries: ' +
        "`update_retry_policy`. It never charges another amount than the plan's.",
    inputSchema: z.strictObject({
        subscription_id: idInput(
            'The id of the late subscription, as `list_subscriptions` returns it.',
        ),
        project: projectInput('write'),
    }),
    outputSchema: z.object({ subscription: subscriptionOutput, project: actedOnOutput }),
    annotations: {
        readOnlyHint: false,
        // It moves a subscriber's money, and a transfer on chain is not undone.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    },
    handler: async ({ subscription_id, project: named }, { mesub, signal }) => {
        const { project: echo, ...retried } = await mesub.retryCharge(subscription_id, {
            project: named,
            signal,
        });
        const project = actedOn(named, echo);
        const subscription = subscriptionOut(retried);
        return {
            data: { subscription, project },
            text:
                inProject(project) +
                'The charge was queued for a new try: it is not settled yet. The subscription ' +
                `is ${known(subscription.status, SUBSCRIPTION_STATUSES)}, with ` +
                `${plural(subscription.failed_pulls, 'failed charge')} on the current period.` +
                `${blockInWords(subscription)} ` +
                `Read it again with get_subscription for the outcome. ${DATA_NOTICE}`,
        };
    },
});
