import * as z from 'zod';

import { DATA_NOTICE, plural } from '../text.js';
import { webhookOut, webhookOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { webhookEvents, webhookId, webhookUrl } from './webhook-inputs.js';

export const updateWebhook = defineTool({
    name: 'update_webhook',
    title: 'Change a webhook endpoint',
    description:
        'Change the URL of a webhook endpoint, the events it takes, or switch it on or off. ' +
        "Changing the URL changes where subscribers' data is sent: every event of the " +
        "project chosen for this endpoint, with subscribers' identifiers, goes to the new " +
        'address from then on, and the old one gets nothing. Ask the merchant before ' +
        'calling it, stating the old and the new value, and only ever set a URL the ' +
        'merchant gave and owns. Removing an event or disabling the endpoint stops a live ' +
        'integration from hearing of it, and disabling mails the account owner. Send only ' +
        'what changes; the signing secret is kept. An endpoint Mesub turned off after ' +
        'failures comes back only with `enabled: true`. To remove an endpoint use ' +
        '`delete_webhook`. Returns the endpoint.',
    inputSchema: z
        .strictObject({
            webhook_id: webhookId,
            url: webhookUrl(
                'The new address: an https URL on a public host. Left out: unchanged.',
            ).optional(),
            events: webhookEvents(
                'The events it takes from now on: this list replaces the current one. Left out: unchanged.',
            ).optional(),
            enabled: z
                .boolean()
                .optional()
                .describe('True to switch it on, false to switch it off. Left out: unchanged.'),
        })
        .refine(
            (args) =>
                args.url !== undefined || args.events !== undefined || args.enabled !== undefined,
            { message: 'Send at least one of url, events or enabled.' },
        ),
    outputSchema: z.object({ webhook: webhookOutput }),
    annotations: {
        readOnlyHint: false,
        // The address and the events it had are overwritten, and data goes elsewhere.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
    },
    handler: async ({ webhook_id, url, events, enabled }, { mesub, signal }) => {
        const endpoint = await mesub.updateWebhook(webhook_id, { url, events, enabled }, signal);
        return {
            data: { webhook: webhookOut(endpoint) },
            text:
                `Webhook endpoint updated: ${endpoint.enabled ? 'enabled' : 'disabled'}, ` +
                `${plural(endpoint.events.length, 'event')}` +
                (endpoint.disabledAt === null
                    ? '. '
                    : ', still turned off by Mesub until it is enabled again. ') +
                DATA_NOTICE,
        };
    },
});
