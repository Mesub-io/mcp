import * as z from 'zod';

import { quoted } from '../text.js';
import { defineTool } from './tool.js';

/**
 * The template the other tools copy: schemas, annotations, one call to the
 * Mesub API, the data and one sentence.
 */
export const ping = defineTool({
    name: 'ping',
    title: 'Check the Mesub API',
    description:
        'Check that the Mesub API is reachable and answering. Use it first when another ' +
        'Mesub tool fails, to tell an outage from a mistake in a request. Returns the ' +
        "API's status and how long it has been running. Reads nothing from the project " +
        'and changes nothing.',
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
        status: z.string().describe('"ok" when the API is up and answering.'),
        uptime_seconds: z.number().describe('Seconds since the API process started.'),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async (_args, { mesub, signal }) => {
        const health = await mesub.health(signal);
        return {
            data: { status: health.status, uptime_seconds: health.uptime },
            // What the API calls its own state: between quotes it cannot close, and cut short.
            text: `The Mesub API answered with status ${quoted(health.status, 40)}.`,
        };
    },
});
