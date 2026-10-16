import * as z from 'zod';

import { DATA_NOTICE } from '../text.js';
import { secretOutput, webhookOut, webhookOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { webhookId } from './webhook-inputs.js';

/** The API's `MAX_SECRET_OVERLAP_HOURS`. */
export const MAX_SECRET_OVERLAP_HOURS = 24;

export const regenerateWebhookSecret = defineTool({
    name: 'regenerate_webhook_secret',
    title: "Replace a webhook endpoint's signing secret",
    description:
        'Draw a new signing secret for a webhook endpoint. It cannot be undone. With ' +
        "`overlap_hours` left out or 0, the old secret stops working at once: the merchant's " +
        'server refuses every webhook until it holds the new one. With 1 to 24, the old one ' +
        'keeps signing for that long: each delivery then carries two signatures, so the ' +
        'server verifies with either while the new one is deployed. A rotation during an ' +
        'overlap ends the oldest secret. Ask the merchant first, and how many hours: none ' +
        'when the old secret leaked. The new secret lands in this conversation: write it to ' +
        "the receiving server's environment, and never commit it, log it or repeat it. To " +
        'read the current one use `get_webhook_secret`.',
    inputSchema: z.strictObject({
        webhook_id: webhookId,
        overlap_hours: z
            .number()
            .int()
            .min(0)
            .max(MAX_SECRET_OVERLAP_HOURS)
            .optional()
            .describe(
                'How many whole hours, 0 to 24, the old secret keeps signing beside the new ' +
                    'one. Left out: 0, it stops at once. Never above 0 when the old secret leaked.',
            ),
    }),
    outputSchema: z.object({ webhook: webhookOutput, secret: secretOutput }),
    annotations: {
        readOnlyHint: false,
        // The secret in use is overwritten, and what verified with it stops, at once or after the overlap.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
    },
    handler: async ({ webhook_id, overlap_hours }, { mesub, signal }) => {
        const { secret, ...endpoint } = await mesub.regenerateWebhookSecret(
            webhook_id,
            overlap_hours,
            signal,
        );
        // Rewritten from a parsed date, so no text of the API's reaches the sentence.
        const ends = Date.parse(endpoint.previousSecretExpiresAt ?? '');
        const until = Number.isNaN(ends)
            ? 'the end of the overlap, as `previous_secret_expires_at` says'
            : new Date(ends).toISOString();
        return {
            data: { webhook: webhookOut(endpoint), secret },
            text:
                (endpoint.previousSecretExpiresAt === null
                    ? 'A new signing secret was drawn and the old one no longer works. '
                    : 'A new signing secret was drawn. The old one still signs beside it until ' +
                      `${until}: every delivery until then carries both signatures, and after ` +
                      'it only the new one. ') +
                'The new secret is in this result: deploy it to the receiving server now, and ' +
                `never commit it or log it. ${DATA_NOTICE}`,
        };
    },
});
