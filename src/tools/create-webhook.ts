import * as z from 'zod';

import { DATA_NOTICE, plural } from '../text.js';
import { secretOutput, webhookOut, webhookOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { webhookEvents, webhookUrl } from './webhook-inputs.js';

export const createWebhook = defineTool({
    name: 'create_webhook',
    title: 'Create a webhook endpoint',
    description:
        "Register a URL of the merchant's server for Mesub to post events to: a " +
        'subscription created, renewed, failing to pay, stopped, cancelled or ended. Use it ' +
        'when wiring a server to Mesub. From then on Mesub sends the chosen events of ' +
        "every subscriber of the project to that URL, with subscribers' identifiers in " +
        'them: create one only for a URL the merchant gave and owns. The URL must be ' +
        'https and on a public host; it is not contacted now. The result holds the ' +
        "endpoint's signing secret in clear, so it lands in this conversation: write it to " +
        'the environment of the receiving server, and never commit it, log it or repeat ' +
        'it. A project holds 16 endpoints, one per URL. To change an endpoint use ' +
        '`update_webhook`; to try it, `send_test_webhook`.',
    inputSchema: z.strictObject({
        url: webhookUrl(
            'Where Mesub posts: an https URL on a public host, 2048 characters at most.',
        ),
        events: webhookEvents('The events to send, at least one, none twice.'),
        enabled: z
            .boolean()
            .optional()
            .describe('False to create it switched off. Enabled when left out.'),
    }),
    outputSchema: z.object({ webhook: webhookOutput, secret: secretOutput }),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        // From now on Mesub posts to a server outside it.
        openWorldHint: true,
    },
    handler: async ({ url, events, enabled }, { mesub, signal }) => {
        const { secret, ...endpoint } = await mesub.createWebhook({ url, events, enabled }, signal);
        return {
            data: { webhook: webhookOut(endpoint), secret },
            text:
                `Webhook endpoint created, ${endpoint.enabled ? 'enabled' : 'disabled'}, for ` +
                `${plural(endpoint.events.length, 'event')}. Its signing secret is in this ` +
                'result: write it to the environment of the receiving server, and never commit ' +
                `it or log it. ${DATA_NOTICE}`,
        };
    },
});
