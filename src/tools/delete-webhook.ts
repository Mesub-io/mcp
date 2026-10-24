import * as z from 'zod';

import { projectInput } from './inputs.js';
import { defineTool } from './tool.js';
import { webhookId } from './webhook-inputs.js';

export const deleteWebhook = defineTool({
    name: 'delete_webhook',
    title: 'Delete a webhook endpoint',
    description:
        'Delete a webhook endpoint for good. Mesub stops posting to it at once, its signing ' +
        'secret and its delivery history are gone, and it cannot be undone: the server ' +
        'behind it stops hearing of renewals, failed payments and cancellations, which ' +
        'breaks a live integration silently. Ask the merchant before calling it, naming ' +
        'the URL of the endpoint (`list_webhooks`). To pause an endpoint and keep it, use ' +
        '`update_webhook` with `enabled: false` instead. Creating one again gives a new id ' +
        'and a new secret.',
    inputSchema: z.strictObject({ webhook_id: webhookId, project: projectInput('write') }),
    outputSchema: z.object({
        deleted: z.boolean(),
        webhook_id: z.string().describe('The id that was asked for, which no longer exists.'),
        project: z
            .string()
            .nullable()
            .describe('The `project` argument as sent, or null: Mesub does not confirm it.'),
    }),
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // A second call finds nothing to delete, and changes nothing.
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ webhook_id, project }, { mesub, signal }) => {
        await mesub.deleteWebhook(webhook_id, { project, signal });
        return {
            // What was sent, never said to be where it was deleted: the API does not echo it.
            data: { deleted: true, webhook_id, project: project ?? null },
            text: 'The webhook endpoint was deleted: Mesub posts nothing to it any more.',
        };
    },
});
