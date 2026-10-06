import type { Client } from '@modelcontextprotocol/client';

import { ERROR_META_KEY } from '../src/tools/result.js';
import {
    PLAN_ID,
    POISON,
    refusal,
    SECRET_VALUE,
    SUBSCRIPTION_ID,
    WALLET,
    WEBHOOK_ID,
} from './fixtures/agent-answers.js';
import {
    connect,
    fakeMesubApi,
    MODERN,
    SERVICE_SECRET,
    startServer,
    TOKEN,
    type FakeApi,
    type TestServer,
} from './helpers.js';
import { ANNOTATIONS, CASES, caseOf, HOOK_URL } from './tool-cases.js';

type Result = Awaited<ReturnType<Client['callTool']>>;

const text = (result: Result) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
/** The one sentence a tool writes, above the JSON of its data. */
const sentence = (result: Result) => text(result).split('\n')[0] ?? '';
const errorOf = (result: Result) =>
    result._meta?.[ERROR_META_KEY] as
        | { code: string; message: string; status: number | null; retryAfterSeconds: number | null }
        | undefined;

// Both generations of client: the 2025 handshake, and the revision without one.
describe.each([
    ['a 2025 client', false],
    [`a ${MODERN} client`, true],
])('the project tools, for %s', (_name, modern) => {
    let api: FakeApi;
    let server: TestServer;
    let client: Client;

    beforeAll(async () => {
        api = await fakeMesubApi();
        // More calls than a connection makes in a minute: its own rate is tested elsewhere.
        server = await startServer(
            { MESUB_API_URL: api.url },
            { limits: { perConnection: 100_000 } },
        );
        client = await connect(server.url, { modern });
        // The client then holds every output schema, and checks each result against its own.
        await client.listTools();
    });
    afterAll(async () => {
        await client.close();
        await server.stop();
        await api.close();
    });
    beforeEach(() => {
        api.calls.length = 0;
    });

    const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });

    it('are listed after ping and search_docs, 23 in all, and nothing else is', async () => {
        const { tools } = await client.listTools();

        expect(tools.map((tool) => tool.name)).toEqual([
            'ping',
            'search_docs',
            ...CASES.map((entry) => entry.tool),
        ]);
        expect(tools).toHaveLength(23);
    });

    it('carry the four hints as intended, a strict input and an output schema', async () => {
        const { tools } = await client.listTools();

        expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(ANNOTATIONS).sort());
        for (const tool of tools) {
            const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] =
                ANNOTATIONS[tool.name] ?? [];
            expect(tool.annotations, tool.name).toEqual({
                readOnlyHint,
                destructiveHint,
                idempotentHint,
                openWorldHint,
            });
            expect(tool.inputSchema, tool.name).toMatchObject({
                type: 'object',
                additionalProperties: false,
            });
            expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' });
            expect(tool.title, tool.name).toBeTruthy();
            expect(tool.description?.length, tool.name).toBeGreaterThan(80);
            // No tool takes a project: the token names it.
            expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/project_?id/i);
            // Every argument is documented: it is all an agent gets.
            const properties = (tool.inputSchema.properties ?? {}) as Record<
                string,
                { description?: string }
            >;
            for (const [argument, schema] of Object.entries(properties)) {
                expect(schema.description, `${tool.name}.${argument}`).toBeTruthy();
            }
        }
    });

    it('say what they are not, and warn where a call is dangerous', async () => {
        const { tools } = await client.listTools();
        const description = (name: string) =>
            tools.find((tool) => tool.name === name)?.description ?? '';

        expect(description('retry_charge')).toMatch(/subscriber's money/);
        expect(description('retry_charge')).toMatch(/Ask the merchant/);
        expect(description('delete_webhook')).toMatch(/cannot be undone/);
        expect(description('delete_webhook')).toMatch(/Ask the merchant/);
        expect(description('regenerate_webhook_secret')).toMatch(/stops working at once/);
        expect(description('regenerate_webhook_secret')).toMatch(/Ask the merchant/);
        expect(description('update_webhook')).toMatch(/where subscribers' data is sent/);
        expect(description('update_webhook')).toMatch(/Ask the merchant/);
        expect(description('get_webhook_secret')).toMatch(/lands in this conversation/);
        expect(description('get_webhook_secret')).toMatch(/never commit it or log it/i);
        expect(description('create_webhook')).toMatch(/lands in this conversation/);
        expect(description('update_project')).toMatch(/name only/);
        for (const tool of tools) {
            if (tool.name === 'ping' || tool.name === 'search_docs') continue;
            // No description quotes what a merchant wrote.
            expect(tool.description, tool.name).not.toContain('Fraise');
        }
    });

    it('say what a model got wrong when it ran against the real API', async () => {
        const { tools } = await client.listTools();
        const tool = (name: string) => tools.find((one) => one.name === name);
        const description = (name: string) => tool(name)?.description ?? '';
        const output = (name: string) => JSON.stringify(tool(name)?.outputSchema ?? {});
        const input = (name: string) => JSON.stringify(tool(name)?.inputSchema ?? {});

        // A reason is a code: the words beside it are what a person is shown.
        for (const name of [
            'get_subscription',
            'retry_charge',
            'get_plan',
            'list_events',
            'get_overview',
            'check_access',
        ]) {
            expect(output(name), name).toMatch(/"reason_label"/);
            expect(output(name), name).toMatch(/`reason_label`[^"]*to show a person/);
            expect(output(name), name).toMatch(/the one to show a person/);
        }

        // The token of an amount, wherever a mint is.
        for (const name of [
            'get_subscription',
            'list_subscriptions',
            'retry_charge',
            'list_events',
            'list_upcoming_charges',
            'get_overview',
        ]) {
            expect(output(name), name).toMatch(/"symbol"/);
        }

        // A tier that retries nothing by itself.
        expect(output('get_overview')).toMatch(/"retries_automatic"/);
        expect(output('get_overview')).toMatch(
            /When `retries_automatic` is false nothing is retried by itself: the merchant fires a retry by hand \(`retry_charge`\)/,
        );

        // check_access serves charges raw, and says where the price is.
        expect(description('check_access')).toMatch(/raw/);
        expect(description('check_access')).toMatch(/`get_subscription` or `get_plan`/);
        expect(output('check_access')).toMatch(/Raw[^"]*`get_subscription` or `get_plan`/);

        // A row of the list is enough to know when a retry is allowed.
        expect(description('retry_charge')).not.toMatch(/with `get_subscription` first/);
        expect(description('retry_charge')).toMatch(
            /`retry_available_at`[^.]*`list_subscriptions`[^.]* is enough/,
        );
        expect(description('retry_charge')).toMatch(/`get_subscription` adds the price to quote/);

        // A made-up or a local address is refused by Mesub.
        for (const name of ['create_webhook', 'update_webhook']) {
            expect(description(name), name).toMatch(/resolve publicly/);
            expect(description(name), name).toMatch(/made-up or local address is refused/);
            expect(input(name), name).toMatch(/resolves publicly/);
        }
    });

    describe.each(CASES)('$tool', (entry) => {
        const answer = () => api.answer(entry.status, entry.answer);

        it('makes exactly its one call, with both credentials, and returns the answer as data', async () => {
            answer();

            const result = await call(entry.tool, entry.args);

            expect(text(result), entry.tool).not.toMatch(/^Mesub error/);
            expect(result.isError).toBeFalsy();
            expect(result.structuredContent).toBeTypeOf('object');
            // The sentence, then the same data for a client that reads only text.
            expect(text(result)).toBe(
                `${sentence(result)}\n${JSON.stringify(result.structuredContent)}`,
            );

            const sent = api.projectCalls();
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ method: entry.method, pathname: entry.pathname });
            expect(sent[0]?.query).toEqual(entry.query);
            expect(sent[0]?.body).toEqual(entry.body);
            expect(sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
            expect(sent[0]?.headers['x-mesub-service-secret']).toBe(SERVICE_SECRET);
            // Neither credential anywhere but in its header.
            expect(sent[0]?.path).not.toContain(TOKEN);
            expect(JSON.stringify(sent[0]?.body ?? null)).not.toContain(TOKEN);
            expect(JSON.stringify(result)).not.toContain(TOKEN);
            expect(JSON.stringify(result)).not.toContain(SERVICE_SECRET);
        });

        it('writes its sentence from counts and states, never from what somebody else wrote', async () => {
            answer();

            const result = await call(entry.tool, entry.args);
            const line = sentence(result);

            expect(line.length).toBeGreaterThan(10);
            expect(line.length).toBeLessThan(600);
            expect(line).not.toMatch(/poison|IGNORE|Fraise|hooks\.example/i);
            for (const value of [WALLET, PLAN_ID, SUBSCRIPTION_ID, WEBHOOK_ID, SECRET_VALUE]) {
                expect(line).not.toContain(value);
            }
            // A field the API serves and no schema names never leaves.
            expect(JSON.stringify(result)).not.toContain('must_not_leak');
        });

        it('refuses an answer of the API that is not what the route serves', async () => {
            api.answer(entry.status === 204 ? 200 : entry.status, { hello: POISON });

            const result = await call(entry.tool, entry.args);

            expect(result.isError).toBe(true);
            expect(errorOf(result)?.code).toBe('unexpected');
            expect(result.structuredContent).toBeUndefined();
            expect(JSON.stringify(result)).not.toContain(POISON);
        });

        it('refuses an argument it does not take, a project id included, before calling Mesub', async () => {
            for (const extra of [{ project_id: 'proj_2' }, { projectId: 'proj_2' }, { x: 1 }]) {
                const result = await call(entry.tool, { ...entry.args, ...extra });

                expect(result.isError).toBe(true);
                expect(text(result)).toContain(Object.keys(extra)[0]);
            }
            expect(api.projectCalls()).toHaveLength(0);
        });

        it.each([
            [404, 'not_found', 'Not found.', {}, /take it from the tool that lists/],
            [
                400,
                'invalid_request',
                ['days is a whole number from 1.', 'page is a whole number from 1.'],
                {},
                /days is a whole number from 1\.; page is a whole number from 1\..*Correct the request/,
            ],
            [429, 'rate_limited', 'Too many requests.', { 'Retry-After': '17' }, /wait 17 seconds/],
            [
                503,
                'unavailable',
                'Not answering.',
                { 'Retry-After': '5' },
                /Temporary.*in 5 seconds/,
            ],
            [500, 'internal_error', 'Internal server error', {}, /Temporary/],
        ] as const)(
            'returns a %i %s as a tool error the agent can act on',
            async (status, code, message, headers, advice) => {
                api.answer(
                    status,
                    refusal(status, code, [message].flat(), status === 429 || status >= 500),
                    headers,
                );

                const result = await call(entry.tool, entry.args);

                expect(result.isError).toBe(true);
                expect(result.structuredContent).toBeUndefined();
                expect(text(result)).toMatch(new RegExp(`^Mesub error ${code}: `));
                expect(text(result)).toMatch(advice);
                expect(errorOf(result)).toMatchObject({
                    code,
                    status,
                    retryAfterSeconds:
                        'Retry-After' in headers ? Number(headers['Retry-After']) : null,
                });
            },
        );
    });

    describe('a failure of this server and not of the request', () => {
        it('never says the service secret was refused', async () => {
            api.answer(
                401,
                refusal(
                    401,
                    'invalid_service_credentials',
                    'This route is for the Mesub MCP server.',
                ),
            );

            const result = await call('list_plans', {});

            expect(result.isError).toBe(true);
            expect(text(result)).toMatch(/^Mesub error unavailable: /);
            expect(JSON.stringify(result)).not.toMatch(/service|secret|credential/i);
            expect(server.logs).toContainEqual(
                expect.objectContaining({
                    level: 'error',
                    message: 'tool call refused by Mesub',
                    code: 'invalid_service_credentials',
                }),
            );
        });

        it('refuses a result too long to hand to a model, whatever the API sent', async () => {
            const long = 'x'.repeat(200);
            const page = caseOf('list_subscriptions').answer as { rows: Record<string, unknown>[] };
            const rows = Array.from({ length: 100 }, (_unused, index) => ({
                ...page.rows[0],
                id: `csub${index}`,
                subscriber: long,
                planId: long,
                mint: long,
                accessUntil: long.slice(0, 60),
                dueAt: long.slice(0, 60),
                retryAvailableAt: long.slice(0, 60),
                lastPaidAt: long.slice(0, 60),
                confirmedAt: long.slice(0, 60),
                planName: 'n'.repeat(5000),
                amount: '9'.repeat(80),
                decimals: null,
            }));
            api.answer(200, { ...page, rows });

            const result = await call('list_subscriptions', {});

            expect(result.isError).toBe(true);
            expect(errorOf(result)?.code).toBe('result_too_large');
            expect(text(result)).toMatch(/smaller `limit`|narrow/);
            expect(text(result).length).toBeLessThan(1000);
        });
    });

    describe('what a log line holds', () => {
        it('names the tool and how it ended, never an argument nor a result', async () => {
            server.lines.length = 0;
            server.logs.length = 0;

            for (const entry of CASES) {
                api.answer(entry.status, entry.answer);
                await call(entry.tool, entry.args);
                api.answer(409, refusal(409, 'conflict', `Refused for ${POISON}.`));
                await call(entry.tool, entry.args);
            }
            await call('update_project', { name: 'Fraise', tier: 'BUSINESS' });

            const written = server.lines.join('\n');
            for (const value of [
                POISON,
                'poison',
                WALLET,
                PLAN_ID,
                SUBSCRIPTION_ID,
                WEBHOOK_ID,
                SECRET_VALUE,
                'whsec_',
                HOOK_URL,
                'hooks.example',
                'Fraise & Co',
                // What prepare_plan was given, and what it was answered.
                'fraise.example',
                'Everything.',
                '9990000',
                'dashboard#plans',
                'Helper',
                'subscription.created',
                '7xKX',
                TOKEN,
                SERVICE_SECRET,
            ]) {
                expect(written, value).not.toContain(value);
            }
            for (const entry of CASES) {
                expect(server.logs).toContainEqual(
                    expect.objectContaining({
                        message: 'tool call',
                        tool: entry.tool,
                        outcome: 'ok',
                    }),
                );
                expect(server.logs).toContainEqual(
                    expect.objectContaining({
                        message: 'tool call',
                        tool: entry.tool,
                        outcome: 'conflict',
                    }),
                );
            }
            const fields = new Set(
                server.logs
                    .filter((line) => line.message === 'tool call')
                    .flatMap((line) => Object.keys(line)),
            );
            expect([...fields].sort()).toEqual(
                [
                    'address',
                    'clientName',
                    'connectionId',
                    'durationMs',
                    'level',
                    'message',
                    'outcome',
                    'projectId',
                    'time',
                    'tool',
                ].sort(),
            );
        });
    });
});
