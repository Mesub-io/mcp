import * as z from 'zod';

import { ROLES, TIERS } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { ToolRefusal } from './result.js';
import { state } from './shapes.js';
import { defineTool } from './tool.js';

export const listProjects = defineTool({
    name: 'list_projects',
    title: 'List the projects',
    description:
        'List the Mesub projects this connection reaches, newest first, with their id, name ' +
        "and tier, and the merchant's role in their organization and what it allows. Call it " +
        'when you do not know which project the merchant means: the other tools take one of ' +
        'these ids, or an exact name, in `project`. A pinned connection lists its one ' +
        'project. For how a project stands against its tier, use `get_project`. Changes ' +
        'nothing.',
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
        organization: z.object({
            id: z.string(),
            name: z.string(),
            role: state(ROLES, "The merchant's role."),
            actions: z
                .array(z.string())
                .describe('What the role allows. Another is refused with `role_required`.'),
        }),
        pinned_project_id: z
            .string()
            .nullable()
            .describe(
                'The project the connection is held to. Null: every project, later ones too.',
            ),
        projects: z
            .array(z.object({ id: z.string(), name: z.string(), tier: state(TIERS) }))
            .describe('Every one, none left out.'),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async (_args, { caller, mesub, signal }) => {
        // An API older than organizations has no such route: nothing is asked of it.
        if (caller.organizationId === null) {
            throw new ToolRefusal(
                'org_scope_unavailable',
                'This Mesub API reaches one project per connection: `get_project` reads it.',
            );
        }
        const { organization, pinnedProjectId, projects } = await mesub.projects({ signal });

        // Whole, never capped: an agent names a project from this list, and one left
        // out would read as one that does not exist. The registry's net still holds.
        return {
            data: {
                organization: {
                    id: organization.id,
                    name: organization.name,
                    role: organization.role,
                    actions: organization.actions,
                },
                pinned_project_id: pinnedProjectId,
                projects,
            },
            text:
                `This connection reaches ${plural(projects.length, 'project')} of the ` +
                `organization, as ${known(organization.role, ROLES)}.` +
                (pinnedProjectId === null
                    ? ''
                    : ' It is pinned to it: another project needs a new connection.') +
                ` ${DATA_NOTICE}`,
        };
    },
});
