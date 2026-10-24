import * as z from 'zod';

import { TIERS } from '../mesub/schemas.js';
import { DATA_NOTICE, known } from '../text.js';
import { projectInput } from './inputs.js';
import { actedOn, inProject, projectMismatch, projectOut, projectOutput } from './shapes.js';
import { defineTool } from './tool.js';

export const MAX_PROJECT_NAME_LENGTH = 24;

export const updateProject = defineTool({
    name: 'update_project',
    title: 'Rename the project',
    description:
        'Rename a Mesub project of the organization. The name only: this tool cannot ' +
        'change the tier or the API key, nor delete the project, and no tool here can. The new name replaces the old one in the dashboard at once. Plans ' +
        'already published keep the old name on chain until the merchant signs an update in ' +
        'the dashboard. Refused when another project of the organization has that name. ' +
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
        project: projectInput('write'),
    }),
    outputSchema: z.object({ project: projectOutput }),
    annotations: {
        readOnlyHint: false,
        // The old name is overwritten.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async ({ name, project: named }, { mesub, signal }) => {
        const { project: echo, ...project } = await mesub.renameProject(name, {
            project: named,
            signal,
        });
        // The echo names the project by its name before the rename: what was named.
        const renamed = actedOn(named, echo);
        // The body is the project renamed: it must be the one the echo names.
        if (renamed !== null && renamed.id !== project.id) {
            throw projectMismatch(named ?? null, renamed.id);
        }
        return {
            data: { project: projectOut(project) },
            text:
                inProject(renamed) +
                `The project was renamed in the dashboard. It is on the ${known(project.tier, TIERS)} tier. ` +
                'Plans already published keep the old name on chain until the merchant signs an ' +
                `update of each in the dashboard: say so. ${DATA_NOTICE}`,
        };
    },
});
