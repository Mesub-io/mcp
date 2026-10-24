import type { Client } from '@modelcontextprotocol/client';

import { ERROR_META_KEY } from '../src/tools/result.js';
import * as answers from './fixtures/agent-answers.js';
import { ORG_ID, POISON, WEBHOOK_ID } from './fixtures/agent-answers.js';
import {
    connect,
    fakeMesubApi,
    OLDER_API,
    startServer,
    type FakeApi,
    type TestServer,
} from './helpers.js';
import { caseOf, ECHOED, PROJECT_CASES, type ToolCase } from './tool-cases.js';

type Result = Awaited<ReturnType<Client['callTool']>>;

const text = (result: Result) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
const sentence = (result: Result) => text(result).split('\n')[0] ?? '';
const errorOf = (result: Result) =>
    result._meta?.[ERROR_META_KEY] as { code: string; message: string } | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (result: Result) => result.structuredContent as any;

/** A token whose connection reaches every project of an organization. */
const ORG_TOKEN = 'mat_org-wide-access-token_abc123';
/** A token of an API older than organizations. */
const OLDER_TOKEN = 'mat_older-api-access-token_abc123';
/** A project argument as an agent may write it: a name with what a query must encode. */
const GIVEN = 'Fraise & Co =%2F é?#';

const echoing = (entry: ToolCase, project: { id: string; name: string }) =>
    !ECHOED.includes(entry.tool)
        ? entry.answer
        : // update_project answers the project itself: its id is the echo's.
          {
              ...(entry.answer as object),
              ...(entry.tool === 'update_project' && { id: project.id }),
              project,
          };
/** The project a write says it acted on: update_project returns the project itself. */
const actedOnOf = (tool: string, result: Result) =>
    tool === 'update_project'
        ? { id: data(result).project.id as string }
        : (data(result).project as unknown);

describe('the project a tool works on', () => {
    let api: FakeApi;
    let server: TestServer;
    /** On a token of an API older than organizations: whoami names no organization. */
    let older: Client;
    /** On an org-wide connection. */
    let org: Client;
    /** On a connection pinned to its project, as the API serves it by default. */
    let pinned: Client;

    beforeAll(async () => {
        api = await fakeMesubApi();
        api.issue(ORG_TOKEN, {
            project: null,
            organization: { id: ORG_ID, name: `Fraise & Co ${POISON}` },
            pinned: false,
        });
        api.issue(OLDER_TOKEN, OLDER_API);
        server = await startServer(
            { MESUB_API_URL: api.url },
            { limits: { perConnection: 100_000 } },
        );
        older = await connect(server.url, { modern: true, token: OLDER_TOKEN });
        org = await connect(server.url, { modern: true, token: ORG_TOKEN });
        pinned = await connect(server.url, { modern: true });
        await older.listTools();
        await org.listTools();
    });
    afterAll(async () => {
        await older.close();
        await pinned.close();
        await org.close();
        await server.stop();
        await api.close();
    });
    beforeEach(() => {
        api.calls.length = 0;
        server.logs.length = 0;
    });

    const call = (client: Client, name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });

    it('sends project as given, and nothing when left out', async () => {
        for (const entry of PROJECT_CASES) {
            api.answer(entry.status, entry.answer);
            // A change names its project on an org-wide connection: left out, a pinned one.
            const leftOutBy =
                ECHOED.includes(entry.tool) || entry.tool === 'delete_webhook' ? pinned : org;
            const without = await call(leftOutBy, entry.tool, entry.args);

            expect(without.isError, entry.tool).toBeFalsy();
            let sent = api.projectCalls();
            expect(sent, entry.tool).toHaveLength(1);
            expect(sent[0]?.query, entry.tool).toEqual(entry.query);
            expect(sent[0]?.path, entry.tool).not.toMatch(/[?&]project=/);
            api.calls.length = 0;

            api.answer(entry.status, echoing(entry, { id: 'proj_9', name: GIVEN }));
            const named = await call(org, entry.tool, { ...entry.args, project: GIVEN });

            expect(named.isError, `${entry.tool} ${text(named)}`).toBeFalsy();
            sent = api.projectCalls();
            expect(sent, entry.tool).toHaveLength(1);
            expect(sent[0]?.query, entry.tool).toEqual({ ...entry.query, project: GIVEN });
            expect(new URL(sent[0]?.path ?? '', 'http://x').searchParams.getAll('project')).toEqual(
                [GIVEN],
            );
            // The body never carries it: the query does.
            expect(JSON.stringify(sent[0]?.body ?? null), entry.tool).not.toContain(GIVEN);
            api.calls.length = 0;
        }
    });

    it('refuses a project argument when the API does not announce org scope', async () => {
        for (const entry of PROJECT_CASES) {
            api.answer(entry.status, echoing(entry, { id: 'proj_1', name: 'Shop' }));
            const result = await call(older, entry.tool, { ...entry.args, project: 'Shop' });

            expect(result.isError, entry.tool).toBe(true);
            expect(errorOf(result), entry.tool).toMatchObject({
                code: 'org_scope_unavailable',
                message:
                    'This Mesub API reaches one project per connection. Call get_project to see ' +
                    'which, and call again without project only if it is the one meant.',
            });
            expect(api.projectCalls(), entry.tool).toHaveLength(0);
        }
        // Without it, the same tools answer as they always did.
        const entry = caseOf('list_plans');
        api.answer(entry.status, entry.answer);
        expect((await call(older, entry.tool, entry.args)).isError).toBeFalsy();
    });

    it('answers the project a write acted on, with the name quoted in the text', async () => {
        for (const tool of ECHOED) {
            const entry = caseOf(tool);
            for (const [named, echo] of [
                ['Shop', { id: 'proj_2', name: 'Shop' }],
                // The name in any case, as the API matches it.
                ['shop', { id: 'proj_2', name: 'Shop' }],
                // By id: the name may be anything.
                ['proj_2', { id: 'proj_2', name: `Shop ${POISON}` }],
            ] as const) {
                api.answer(entry.status, echoing(entry, echo));
                const result = await call(org, tool, { ...entry.args, project: named });

                expect(result.isError, `${tool} ${text(result)}`).toBeFalsy();
                expect(actedOnOf(tool, result), tool).toEqual(
                    tool === 'update_project' ? { id: echo.id } : echo,
                );
                expect(sentence(result), tool).toContain(`"${echo.name}"`);
                expect(api.projectCalls(), tool).toHaveLength(1);
                api.calls.length = 0;
            }

            // Left out: the API chose, the pin, and its answer still says which.
            api.answer(entry.status, entry.answer);
            const left = await call(pinned, tool, entry.args);
            expect(actedOnOf(tool, left), tool).toEqual(
                tool === 'update_project' ? { id: 'proj_1' } : answers.PROJECT_ECHO,
            );
            expect(sentence(left), tool).toContain(JSON.stringify(answers.PROJECT_ECHO.name));
            api.calls.length = 0;
        }
    });

    it('refuses a write whose echo names another project', async () => {
        for (const tool of ECHOED) {
            const entry = caseOf(tool);
            for (const [named, echo] of [
                ['Shop', { id: 'proj_3', name: 'Other' }],
                // An id that is not the echo's, whatever the name.
                ['proj_2', { id: 'proj_3', name: 'Other' }],
                // Close is not the same.
                ['Shop', { id: 'proj_3', name: 'Shop ' }],
            ] as const) {
                api.answer(entry.status, echoing(entry, echo));
                const result = await call(org, tool, { ...entry.args, project: named });

                expect(result.isError, tool).toBe(true);
                expect(errorOf(result), tool).toMatchObject({
                    code: 'project_mismatch',
                    message:
                        'Mesub acted on another project than the one named. Tell the merchant and stop.',
                });
                expect(result.structuredContent, tool).toBeUndefined();
                // Never called again: the write went through, somewhere.
                expect(api.projectCalls(), tool).toHaveLength(1);
                api.calls.length = 0;
            }
            const lines = server.logs.filter(
                (line) => line.message === 'tool call acted on another project',
            );
            expect(lines, tool).toHaveLength(3);
            expect(lines[0], tool).toMatchObject({
                level: 'error',
                tool,
                named: 'Shop',
                actedOnProjectId: 'proj_3',
                organizationId: ORG_ID,
            });
            server.logs.length = 0;
        }
    });

    it('refuses a write that names a project and is answered without one', async () => {
        for (const tool of ECHOED) {
            const entry = caseOf(tool);
            const { project: _echo, ...unsaid } = entry.answer as Record<string, unknown>;
            api.answer(entry.status, unsaid);

            const result = await call(org, tool, { ...entry.args, project: 'Shop' });

            expect(result.isError, tool).toBe(true);
            expect(errorOf(result)?.code, tool).toBe('project_mismatch');
            expect(api.projectCalls(), tool).toHaveLength(1);
            api.calls.length = 0;

            // Named nothing, an API older than the echo: nothing to compare, nothing said.
            const left = await call(older, tool, entry.args);
            expect(left.isError, `${tool} ${text(left)}`).toBeFalsy();
            if (tool !== 'update_project') expect(data(left).project, tool).toBeNull();
            expect(sentence(left), tool).not.toMatch(/Project acted on|in the project/);
            api.calls.length = 0;
        }
    });

    it('refuses a change that names no project on an org-wide connection, before any call', async () => {
        const changes = PROJECT_CASES.filter(
            (entry) => ECHOED.includes(entry.tool) || entry.tool === 'delete_webhook',
        );
        expect(changes).toHaveLength(9);
        for (const entry of changes) {
            api.answer(entry.status, entry.answer);
            const result = await call(org, entry.tool, entry.args);

            expect(result.isError, entry.tool).toBe(true);
            expect(text(result), entry.tool).toBe(
                'Mesub error project_required: Name the project: list_projects returns the ' +
                    'projects of this organization. Call `list_projects`, ask the merchant which ' +
                    'project when it is not clear, then call again with `project`.',
            );
            expect(api.projectCalls(), entry.tool).toHaveLength(0);

            // A pinned connection leaves it to its pin, and a read to every project.
            expect((await call(pinned, entry.tool, entry.args)).isError, entry.tool).toBeFalsy();
            api.calls.length = 0;
        }
        api.answer(200, caseOf('list_plans').answer);
        expect((await call(org, 'list_plans', {})).isError).toBeFalsy();
    });

    it('refuses a rename whose echo is not the project it answers', async () => {
        const entry = caseOf('update_project');
        api.answer(200, { ...answers.renamedProject, id: 'proj_2' });

        const result = await call(pinned, 'update_project', entry.args);

        expect(errorOf(result)?.code).toBe('project_mismatch');
        expect(api.projectCalls()).toHaveLength(1);
    });

    it('does not present the argument of delete_webhook as the project it acted on', async () => {
        const entry = caseOf('delete_webhook');
        api.answer(204, '');

        const named = await call(org, 'delete_webhook', {
            webhook_id: WEBHOOK_ID,
            project: 'Shop',
        });
        const left = await call(pinned, 'delete_webhook', { webhook_id: WEBHOOK_ID });

        expect(data(named)).toEqual({ deleted: true, webhook_id: WEBHOOK_ID, project: 'Shop' });
        expect(data(left)).toEqual({ deleted: true, webhook_id: WEBHOOK_ID, project: null });
        expect(sentence(named)).not.toMatch(/Shop/);
        expect(sentence(named)).toBe(sentence(left));
        expect(api.projectCalls().map((sent) => sent.query)).toEqual([
            { ...entry.query, project: 'Shop' },
            entry.query,
        ]);
    });

    it('refuses a project with a control character, before any call', async () => {
        for (const project of ['Sh\u0000op', 'Shop\n', '\u007f', 'a\tb', '', 'x'.repeat(101), 42]) {
            for (const entry of PROJECT_CASES) {
                const result = await call(org, entry.tool, { ...entry.args, project });

                expect(result.isError, `${entry.tool} ${JSON.stringify(project)}`).toBe(true);
            }
        }
        expect(api.projectCalls()).toHaveLength(0);
    });

    it("an org-wide connection's list names each row's project", async () => {
        const two = <T extends object>(rows: T[]) =>
            rows.map((row, index) =>
                index === 0 ? row : { ...row, projectId: 'proj_2', projectName: 'Shop' },
            );
        const reads: [string, Record<string, unknown>, unknown, (result: Result) => unknown[]][] = [
            ['list_plans', {}, two(answers.plans), (r) => data(r).plans],
            [
                'list_subscriptions',
                {},
                { ...answers.subscriptionPage, rows: two(answers.subscriptionPage.rows) },
                (r) => data(r).subscriptions,
            ],
            ['list_events', { day: '2026-10-01' }, two(answers.eventLines), (r) => data(r).events],
            ['list_upcoming_charges', {}, two(answers.upcoming), (r) => data(r).upcoming],
            [
                'get_overview',
                {},
                {
                    ...answers.overview,
                    overview: {
                        ...answers.overview.overview,
                        nextUp: two([
                            ...answers.overview.overview.nextUp,
                            ...answers.overview.overview.nextUp,
                        ]),
                    },
                },
                (r) => data(r).overview.next_up,
            ],
        ];

        for (const [tool, args, answer, rows] of reads) {
            api.answer(200, answer);
            const result = await call(org, tool, args);

            expect(result.isError, `${tool} ${text(result)}`).toBeFalsy();
            expect(
                rows(result).map((row) => [
                    (row as { project_id: string }).project_id,
                    (row as { project_name: string }).project_name,
                ]),
                tool,
            ).toEqual([
                ['proj_1', `Fraise ${POISON}`],
                ['proj_2', 'Shop'],
            ]);
        }

        api.answer(200, answers.planDetail);
        const plan = await call(org, 'get_plan', caseOf('get_plan').args);
        expect(data(plan).plan).toMatchObject({
            project_id: 'proj_1',
            project_name: `Fraise ${POISON}`,
        });

        api.answer(200, answers.subscription);
        const subscription = await call(org, 'get_subscription', caseOf('get_subscription').args);
        expect(data(subscription).subscription).toMatchObject({ project_id: 'proj_1' });
    });

    it('says which projects of an overview retry by themselves', async () => {
        api.answer(200, {
            ...answers.overview,
            overview: {
                ...answers.overview.overview,
                retriesAutomatic: false,
                retriesAutomaticByProject: [
                    { projectId: 'proj_1', projectName: `Fraise ${POISON}`, honoured: true },
                    { projectId: 'proj_2', projectName: 'Shop', honoured: false },
                ],
            },
        });

        const result = await call(org, 'get_overview', {});

        expect(data(result).overview.retries_automatic_by_project).toEqual([
            { project_id: 'proj_1', project_name: `Fraise ${POISON}`, honoured: true },
            { project_id: 'proj_2', project_name: 'Shop', honoured: false },
        ]);
        expect(sentence(result)).toMatch(
            /, 1 with a retry to come\. 1 of 2 projects does not retry by itself /,
        );
        expect(sentence(result)).not.toMatch(/Shop|Fraise/);
    });

    it('reads rows and an overview of an API older than the project of a row', async () => {
        const strip = <T extends object>(row: T) => {
            const { projectId: _id, projectName: _name, ...rest } = row as Record<string, unknown>;
            return rest;
        };
        api.answer(200, answers.plans.map(strip));
        const plans = await call(older, 'list_plans', {});
        expect(data(plans).plans[0]).toMatchObject({ project_id: null, project_name: null });

        const { retriesAutomaticByProject: _gone, ...overview } = answers.overview.overview;
        api.answer(200, { ...answers.overview, overview });
        const read = await call(older, 'get_overview', {});
        expect(read.isError).toBeFalsy();
        expect(data(read).overview.retries_automatic_by_project).toBeNull();
    });
});
