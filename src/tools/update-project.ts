import * as z from 'zod';

import { DATA_NOTICE } from '../text.js';
import { projectOut, projectOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const MAX_PROJECT_NAME_LENGTH = 24;

export const updateProject = defineTool({
    name: 'update_project',
    title: 'Rename the project',
    description:
        'Rename the Mesub project this connection is for. The name only: this tool cannot ' +
        'change the tier, the API key, the allowed origins, nor delete the project, and no ' +
        'tool here can. The new name replaces the old one in the dashboard at once. Plans ' +
        'already published keep the old name on chain until the merchant signs an update in ' +
        'the dashboard. Refused when the account has another project under that name. ' +
        'Returns the project as `get_project` does.',
    inputSchema: z.strictObject({
        name: z
            .string()
            .min(1)
            .max(MAX_PROJECT_NAME_LENGTH)
            .regex(/^[\p{Script=Latin}0-9 .&'-]+$/u, "Letters, digits, spaces and - ' . & only.")
            .refine((name) => name === name.trim() && !name.includes('  '), {
                message: 'No space at either end, and no two spaces in a row.',
            })
            .describe(
                `The new name, 1 to ${MAX_PROJECT_NAME_LENGTH} characters: Latin letters, ` +
                    "digits, single spaces and the marks - ' . &",
            ),
    }),
    outputSchema: z.object({ project: projectOutput }),
    annotations: {
        readOnlyHint: false,
        // The old name is overwritten.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ name }, { mesub, signal }) => {
        const project = await mesub.renameProject(name, signal);
        return {
            data: { project: projectOut(project) },
            text: `The project was renamed. It is on the ${project.tier} tier. ${DATA_NOTICE}`,
        };
    },
});
