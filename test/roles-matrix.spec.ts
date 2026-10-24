import type { Client } from '@modelcontextprotocol/client';

import { TOOLS } from '../src/tools/index.js';
import { ERROR_META_KEY, ROLE_ADVICE } from '../src/tools/result.js';
import { forgetNetwork } from '../src/tools/tokens.js';
import { ORG_ID, refusal } from './fixtures/agent-answers.js';
import {
    bearer,
    callTool,
    CHALLENGE,
    connect,
    fakeMesubApi,
    readJsonRpc,
    startServer,
    type FakeApi,
    type TestServer,
} from './helpers.js';
import { CASES } from './tool-cases.js';

// What the Mesub API answers a connection whose person may not do what a tool
// asks, or whose call reaches no project of it (backend: AgentProjectGuard and
// AgentScope). The API decides; this server relays each refusal as it came,
// with the advice for its code, and never calls again.

type Result = Awaited<ReturnType<Client['callTool']>>;

const text = (result: Result) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
    result._meta?.[ERROR_META_KEY] as
        { code: string; message: string; status: number | null } | undefined;

/** The refusals of the API, in its own words (agent-project.guard.ts, permissions.ts). */
const REFUSALS: [number, string, string, string][] = [
    [403, 'role_required', 'Only the Owner and Admins can manage webhooks.', ROLE_ADVICE],
    [
        403,
        'project_outside_pin',
        // The pin's name, written by a person, between the API's own quotes.
        'This connection reaches “Fraise” only. Connect again without a pin to work on another project.',
        'This connection reaches one project. For another, the merchant connects again and ' +
            'chooses the whole organization or that project.',
    ],
    [
        404,
        'project_not_found',
        'No project of this organization is called that. list_projects returns them.',
        'Take the project from `list_projects`: its id or its exact name.',
    ],
    [
        400,
        'project_ambiguous',
        'Two projects match that name: use the id list_projects returns.',
        "Call again with the project's id from `list_projects`.",
    ],
    [
        400,
        'project_required',
        'Name the project: list_projects returns the projects of this organization.',
        'Call `list_projects`, ask the merchant which project when it is not clear, then call ' +
            'again with `project`.',
    ],
];

const INVALID_TOKEN = 'That access token is not valid.';
const RECONNECT =
    'The connection to Mesub expired or was revoked: connect again, then repeat the call.';

const writes = new Set(TOOLS.filter((tool) => !tool.annotations.readOnlyHint).map((t) => t.name));

describe('every tool against every refusal of a role or a scope', () => {
    let api: FakeApi;
    let server: TestServer;
    let client: Client;

    beforeAll(async () => {
        api = await fakeMesubApi();
        server = await startServer(
            { MESUB_API_URL: api.url },
            { limits: { perConnection: 100_000, checksPerAddress: 10_000, checksTotal: 10_000 } },
        );
        client = await connect(server.url, { modern: true });
    });
    afterAll(async () => {
        await client.close();
        await server.stop();
        await api.close();
    });
    beforeEach(() => {
        api.calls.length = 0;
        forgetNetwork();
    });

    it.each(REFUSALS)(
        'every tool relays each refusal of the API as it is: %i %s',
        async (status, code, message, advice) => {
            api.answer(status, refusal(status, code, message));

            for (const entry of CASES) {
                const result = await client.callTool({ name: entry.tool, arguments: entry.args });

                expect(result.isError, entry.tool).toBe(true);
                expect(text(result), entry.tool).toBe(`Mesub error ${code}: ${message} ${advice}`);
                expect(errorOf(result), entry.tool).toMatchObject({ code, message, status });
                expect(result.structuredContent, entry.tool).toBeUndefined();
            }
        },
    );

    it('every tool relays invalid_agent_token, and the next request is an HTTP challenge', async () => {
        api.answer(401, refusal(401, 'invalid_agent_token', INVALID_TOKEN));

        for (const entry of CASES) {
            // One token each: a token the API refused is remembered as refused.
            const token = `mat_matrix_${entry.tool}`;
            api.issue(token, { organization: { id: ORG_ID, name: 'Fraise & Co' }, pinned: true });

            const first = await callTool(server.url, entry.tool, entry.args, bearer(token));
            expect(first.status, entry.tool).toBe(200);
            expect(await readJsonRpc(first), entry.tool).toMatchObject({
                result: {
                    isError: true,
                    content: [
                        { text: `Mesub error invalid_agent_token: ${INVALID_TOKEN} ${RECONNECT}` },
                    ],
                    _meta: { [ERROR_META_KEY]: { code: 'invalid_agent_token', status: 401 } },
                },
            });

            const checks = api.callsTo('/agent/whoami').length;
            const next = await callTool(server.url, entry.tool, entry.args, bearer(token));
            expect(next.status, entry.tool).toBe(401);
            expect(next.headers.get('www-authenticate'), entry.tool).toBe(CHALLENGE);
            // Refused without asking the API again, and without calling the route.
            expect(api.callsTo('/agent/whoami'), entry.tool).toHaveLength(checks);
        }
    });

    it('no tool retries a write after a refusal', async () => {
        const refused: [number, string, string][] = [
            ...REFUSALS.map(([status, code, message]): [number, string, string] => [
                status,
                code,
                message,
            ]),
            [401, 'invalid_agent_token', INVALID_TOKEN],
        ];
        const changing = CASES.filter((entry) => writes.has(entry.tool));
        expect(changing.map((entry) => entry.tool).sort()).toEqual([...writes].sort());

        for (const [status, code, message] of refused) {
            api.answer(status, refusal(status, code, message));
            for (const entry of changing) {
                const token = `mat_once_${code}_${entry.tool}`;
                api.issue(token, {
                    organization: { id: ORG_ID, name: 'Fraise & Co' },
                    pinned: true,
                });
                api.calls.length = 0;

                const response = await callTool(server.url, entry.tool, entry.args, bearer(token));
                // A 2025 answer is a stream: its headers come before the tool has run.
                // Read to its result, then count.
                expect(await readJsonRpc(response), `${entry.tool} ${code}`).toMatchObject({
                    result: { isError: true, _meta: { [ERROR_META_KEY]: { code } } },
                });

                expect(api.projectCalls(), `${entry.tool} ${code}`).toHaveLength(1);
            }
        }
    });

    it("a removed person's next request is refused at the seam", async () => {
        const token = 'mat_removed-person_abc123';
        api.issue(token, { organization: { id: ORG_ID, name: 'Fraise & Co' }, pinned: true });
        const entry = CASES.find((one) => one.tool === 'list_plans');
        api.answer(entry?.status ?? 200, entry?.answer);
        const before = await callTool(server.url, 'list_plans', {}, bearer(token));
        expect(await readJsonRpc(before)).toMatchObject({
            result: { structuredContent: { total: 2 } },
        });

        // Removed from the organization: the API takes the token no more.
        api.revoke(token);
        api.calls.length = 0;

        for (const tool of CASES.map((one) => one.tool)) {
            const after = await callTool(server.url, tool, {}, bearer(token));

            expect(after.status, tool).toBe(401);
            expect(after.headers.get('www-authenticate'), tool).toBe(CHALLENGE);
            expect(await after.text(), tool).not.toMatch(/Fraise|list_|role/);
        }
        // Asked of whoami only, never of a route of a project.
        expect(api.projectCalls()).toHaveLength(0);
        expect(api.callsTo('/agent/whoami').length).toBeGreaterThan(0);
    });
});
