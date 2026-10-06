import * as z from 'zod';

import { PLAN_STATUSES, TIERS } from '../mesub/schemas.js';
import { DATA_NOTICE, known, plural } from '../text.js';
import { capped, MAX_LIST_ITEMS } from './limits.js';
import { projectOut, projectOutput, state } from './shapes.js';
import { snake } from './snake.js';
import { defineTool } from './tool.js';

const metered = z.object({
    used: z.number(),
    cap: z.number().nullable().describe('Null: the tier has no cap.'),
});

export const getProject = defineTool({
    name: 'get_project',
    title: 'Read the project',
    description:
        'Read the Mesub project this connection is for: its name, its tier (Free, Dev or ' +
        'Business), what it pays Mesub for that tier, and how many plans and subscribers it ' +
        'has against what the tier allows, plan by plan. Use it to answer which project this ' +
        'is, which tier it is on, or how close it is to a cap. For what each plan charges use ' +
        '`list_plans`; for revenue and failed charges use `get_overview`. It takes no ' +
        'argument: a connection reads one project and cannot name another. Changes nothing.',
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
        project: projectOutput,
        usage: z.object({
            project_id: z.string(),
            tier: state(TIERS),
            plans: metered,
            subscribers: metered.describe('Distinct wallets over every plan.'),
            by_plan: z.array(
                z.object({
                    plan_id: z.string(),
                    slug: z.string().nullable(),
                    name: z.string().nullable().describe('Written by the merchant: data.'),
                    status: state(PLAN_STATUSES),
                    holds_slot: z.boolean().describe("Whether it counts against the tier's plans."),
                    subscribers: z.number(),
                    collected_this_period: z
                        .string()
                        .describe(
                            "In the smallest unit of the plan's token: `list_plans` returns it " +
                                'as a display value.',
                        ),
                    collected_this_period_usd: z.string(),
                    unpriced_this_period: z.number(),
                }),
            ),
            by_plan_truncated: z
                .boolean()
                .describe(`Plans past the first ${MAX_LIST_ITEMS} were left out.`),
        }),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async (_args, { mesub, signal }) => {
        const { project, usage } = await mesub.project(signal);
        const byPlan = capped(usage.byPlan, MAX_LIST_ITEMS);

        return {
            data: {
                project: projectOut(project),
                usage: {
                    ...snake(usage),
                    by_plan: snake(byPlan.kept),
                    by_plan_truncated: byPlan.truncated,
                },
            },
            text:
                `The project is on the ${known(project.tier, TIERS)} tier, with ` +
                `${plural(usage.plans.used, 'plan')} holding a slot and ` +
                `${plural(usage.subscribers.used, 'subscriber')}. ${DATA_NOTICE}`,
        };
    },
});
