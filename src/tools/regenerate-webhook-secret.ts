import * as z from 'zod';

import { DATA_NOTICE } from '../text.js';
import { secretOutput, webhookOut, webhookOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { webhookId } from './webhook-inputs.js';

export const regenerateWebhookSecret = defineTool({
    name: 'regenerate_webhook_secret',
    title: "Replace a webhook endpoint's signing secret",
    description:
        'Draw a new signing secret for a webhook endpoint. The old secret stops working at ' +
        "once, with no overlap: until the merchant's server holds the new one, it refuses " +
        'every webhook Mesub sends, so a live integration breaks the moment this is called. ' +
        'It cannot be undone. Ask the merchant before calling it, and only when the new ' +
        'secret can be deployed right away, typically because the old one leaked. The ' +
        'result holds the new secret in clear, so it lands in this conversation: write it ' +
        "to the receiving server's environment, and never commit it, log it or repeat it. " +
        'To read the current secret without changing it use `get_webhook_secret`.',
    inputSchema: z.strictObject({ webhook_id: webhookId }),
    outputSchema: z.object({ webhook: webhookOutput, secret: secretOutput }),
    annotations: {
        readOnlyHint: false,
        // The secret in use is overwritten, and what verified with it stops.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    },
    handler: async ({ webhook_id }, { mesub, signal }) => {
        const { secret, ...endpoint } = await mesub.regenerateWebhookSecret(webhook_id, signal);
        return {
            data: { webhook: webhookOut(endpoint), secret },
            text:
                'A new signing secret was drawn and the old one no longer works. It is in this ' +
                'result: deploy it to the receiving server now, and never commit it or log ' +
                `it. ${DATA_NOTICE}`,
        };
    },
});
