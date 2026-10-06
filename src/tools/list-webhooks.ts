import * as z from 'zod';

import { DATA_NOTICE, plural } from '../text.js';
import { capped, MAX_LIST_ITEMS } from './limits.js';
import { webhookOut, webhookOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const listWebhooks = defineTool({
    name: 'list_webhooks',
    title: 'List the webhook endpoints',
    description:
        "List the webhook endpoints of the project: the URLs on the merchant's servers " +
        'Mesub posts events to, which events each one takes, whether it is enabled, and ' +
        'whether its deliveries are failing or Mesub turned it off after three days of ' +
        'failures. Use it to find an endpoint and its id, or to answer "are my webhooks ' +
        'working". For what was sent to one and what it answered use ' +
        '`list_webhook_deliveries`. It never returns a signing secret, only a hint of it: ' +
        '`get_webhook_secret` returns the secret. Changes nothing.',
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
        webhooks: z.array(webhookOutput).describe('Oldest first. A project holds 16 at most.'),
        total: z.number(),
        truncated: z.boolean(),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async (_args, { mesub, signal }) => {
        const all = await mesub.webhooks(signal);
        const { kept, truncated } = capped(all, MAX_LIST_ITEMS);

        return {
            data: { webhooks: kept.map(webhookOut), total: all.length, truncated },
            text:
                all.length === 0
                    ? 'The project has no webhook endpoint.'
                    : `${plural(all.length, 'webhook endpoint')}: ` +
                      `${all.filter((endpoint) => endpoint.enabled).length} enabled, ` +
                      `${all.filter((endpoint) => endpoint.failingSince !== null).length} failing, ` +
                      `${all.filter((endpoint) => endpoint.disabledAt !== null).length} turned off ` +
                      `by Mesub. ${DATA_NOTICE}`,
        };
    },
});
