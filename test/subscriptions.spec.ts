import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import {
    bearer,
    fakeMesubApi,
    INITIALIZE,
    MODERN,
    post,
    readJsonRpc,
    startServer,
    TOKEN,
    type FakeApi,
    type TestServer,
} from './helpers.js';

/*
 * M2. A `subscriptions/listen` stream is opened by one request and then lives
 * on: its token is checked once, so it would outlive a revoke, and whoever
 * opens enough of them would take every stream the instance has. No tool
 * publishes anything on such a stream today. So none is served, and nothing
 * says one could be: this comes back with the first tool that needs it, and
 * with a re-check of the token while a stream is open.
 */
describe('M2: subscriptions/listen', () => {
    let api: FakeApi;
    let server: TestServer;
    let meta: Record<string, unknown>;

    beforeAll(async () => {
        api = await fakeMesubApi();
        server = await startServer({ MESUB_API_URL: api.url });

        // The envelope a 2026 client sends, learnt from the SDK's own client.
        let seen: { params?: { _meta?: Record<string, unknown> } } | undefined;
        const spy: typeof fetch = (input, init) => {
            if (typeof init?.body === 'string' && seen === undefined) {
                seen = JSON.parse(init.body) as typeof seen;
            }
            return fetch(input, init);
        };
        const client = new Client(
            { name: 'test-client', version: '1.0.0' },
            { versionNegotiation: { mode: { pin: MODERN } } },
        );
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
                authProvider: { token: async () => TOKEN },
                fetch: spy,
            }),
        );
        await client.close();
        meta = seen?.params?._meta ?? {};
    });
    afterAll(async () => {
        await server.stop();
        await api.close();
    });

    const listen = (id: number, token = TOKEN) =>
        post(
            server.url,
            {
                jsonrpc: '2.0',
                id,
                method: 'subscriptions/listen',
                params: { _meta: meta, notifications: { toolsListChanged: true } },
            },
            {
                ...bearer(token),
                'MCP-Protocol-Version': MODERN,
                'Mcp-Method': 'subscriptions/listen',
            },
        );

    it('opens no stream: the request is answered at once, with an error', async () => {
        expect(Object.keys(meta).length).toBeGreaterThan(0);
        const response = await listen(1);

        expect(response.headers.get('content-type')).not.toContain('text/event-stream');
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            error: { code: expect.any(Number), message: expect.any(String) },
        });
    });

    it('so no stream outlives a revoke, and nobody can take them all', async () => {
        api.issue('mat_greedy', { connection_id: 'conn_greedy' });
        for (let i = 0; i < 50; i++) {
            const response = await listen(100 + i, 'mat_greedy');
            expect(response.headers.get('content-type')).not.toContain('text/event-stream');
            await response.text();
        }

        // Another caller's requests are served as ever.
        const list = await post(
            server.url,
            { jsonrpc: '2.0', id: 3, method: 'tools/list' },
            { ...bearer(), 'MCP-Protocol-Version': '2025-06-18' },
        );
        expect(list.status).toBe(200);
    });

    it('still needs a token, like everything else', async () => {
        const response = await post(
            server.url,
            { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: { _meta: meta } },
            { 'MCP-Protocol-Version': MODERN },
        );
        expect(response.status).toBe(401);
    });

    it('does not tell a client its lists can change: no stream would say so', async () => {
        const old = (await readJsonRpc(await post(server.url, INITIALIZE, bearer()))) as {
            result: { capabilities: { tools?: { listChanged?: boolean } } };
        };
        expect(old.result.capabilities.tools).toBeDefined();
        expect(old.result.capabilities.tools?.listChanged ?? false).toBe(false);

        const modern = (await readJsonRpc(
            await post(
                server.url,
                { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
                { ...bearer(), 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'server/discover' },
            ),
        )) as { result?: { capabilities?: { tools?: { listChanged?: boolean } } } };
        expect(modern.result?.capabilities?.tools).toBeDefined();
        expect(modern.result?.capabilities?.tools?.listChanged ?? false).toBe(false);
        expect(JSON.stringify(modern.result?.capabilities)).not.toMatch(/subscri/i);
    });
});
