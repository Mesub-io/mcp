import * as z from 'zod';

import { secretOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { webhookId } from './webhook-inputs.js';

export const getWebhookSecret = defineTool({
    name: 'get_webhook_secret',
    title: "Reveal a webhook endpoint's signing secret",
    description:
        "Return the signing secret of a webhook endpoint in clear: what the merchant's " +
        'server verifies the signature of every webhook with. The value lands in this ' +
        'conversation, where whoever reads it can forge webhooks to that server. Call it ' +
        'only to write the secret to the environment of the server that receives the ' +
        'webhooks, when the merchant asked for that; never commit it or log it, never ' +
        'write it in code, a file under version control or a message, and do not repeat ' +
        'it back. To know which secret an endpoint has without revealing it, ' +
        '`list_webhooks` returns a hint. If it may have leaked, replace it with ' +
        '`regenerate_webhook_secret`. Changes nothing.',
    inputSchema: z.strictObject({ webhook_id: webhookId }),
    outputSchema: z.object({ secret: secretOutput }),
    annotations: {
        // It changes nothing. What it reveals is in the description: no hint says it.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ webhook_id }, { mesub, signal }) => {
        const { secret } = await mesub.webhookSecret(webhook_id, signal);
        return {
            data: { secret },
            text:
                'The signing secret is in this result. Write it to the environment of the ' +
                'server that receives the webhooks; never commit it, log it or repeat it.',
        };
    },
});
