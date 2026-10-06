import * as z from 'zod';

import { DATA_NOTICE } from '../text.js';
import { deliveryOut, deliveryOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { webhookEvent, webhookId } from './webhook-inputs.js';

export const sendTestWebhook = defineTool({
    name: 'send_test_webhook',
    title: 'Send a test webhook',
    description:
        'Make Mesub post one signed test webhook to an endpoint, to check that the ' +
        "merchant's server receives it and verifies its signature. It sends the plain " +
        '`test` event, or a sample of one of the events the endpoint takes. The body is ' +
        'marked `test: true` and concerns no real subscriber, but it does reach the ' +
        "merchant's server, which may act on it. One try, no retry, one test at a time per " +
        'endpoint, five a minute; refused on a disabled endpoint. The delivery is queued: ' +
        'read `list_webhook_deliveries` a moment later for what the server answered. It ' +
        'cannot send a real event again.',
    inputSchema: z.strictObject({
        webhook_id: webhookId,
        event: webhookEvent
            .optional()
            .describe(
                'A sample of this event, which the endpoint must take. Left out: the plain ' +
                    '`test` event.',
            ),
    }),
    outputSchema: z.object({ delivery: deliveryOutput }),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        // It makes Mesub call the merchant's server.
        openWorldHint: true,
    },
    handler: async ({ webhook_id, event }, { mesub, signal }) => {
        const delivery = await mesub.sendTestWebhook(webhook_id, { event }, signal);
        return {
            data: { delivery: deliveryOut(delivery) },
            text:
                `The test delivery is queued, status ${delivery.status}. Read ` +
                `list_webhook_deliveries in a moment for what the endpoint answered. ${DATA_NOTICE}`,
        };
    },
});
