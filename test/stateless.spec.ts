import type { Client } from '@modelcontextprotocol/client';

import {
    connect,
    fakeMesubApi,
    INITIALIZE,
    post,
    readJsonRpc,
    startServer,
    TOKEN,
} from './helpers.js';
import type { FakeApi, TestServer } from './helpers.js';

describe('statelessness', () => {
    let api: FakeApi;
    let first: TestServer;
    let second: TestServer;

    beforeEach(async () => {
        api = await fakeMesubApi();
        first = await startServer({ MESUB_API_URL: api.url });
        second = await startServer({ MESUB_API_URL: api.url });
    });
    afterEach(async () => {
        await first.stop();
        await second.stop();
        await api.close();
    });

    /** A fetch sending each request of one client to the other instance, in turn. */
    const alternating = () => {
        const served: number[] = [];
        const balanced: typeof fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            url.port = String(served.length % 2 === 0 ? first.port : second.port);
            served.push(Number(url.port));
            return fetch(url, init);
        };
        return { balanced, served };
    };

    it.each([
        ['a 2025 client', false],
        ['a 2026-07-28 client', true],
    ])('serves one conversation of %s from two instances', async (_name, modern) => {
        const { balanced, served } = alternating();
        const client: Client = await connect(first.url, { modern, fetch: balanced });

        const { tools } = await client.listTools();
        const one = await client.callTool({ name: 'ping', arguments: {} });
        const two = await client.callTool({ name: 'ping', arguments: {} });
        const three = await client.callTool({ name: 'ping', arguments: {} });
        await client.close();

        expect(tools.map((tool) => tool.name)).toEqual(['ping', 'search_docs']);
        for (const result of [one, two, three]) {
            expect(result.isError).toBeFalsy();
            expect(result.structuredContent).toEqual({ status: 'ok', uptime_seconds: 42 });
        }

        // Both instances answered, and none refused a request the other began.
        expect(new Set(served)).toEqual(new Set([first.port, second.port]));
        expect(served.filter((port) => port === first.port).length).toBeGreaterThan(1);
        expect(served.filter((port) => port === second.port).length).toBeGreaterThan(1);
    });

    it('answers a tool call that no handshake came before', async () => {
        // An instance that never saw this client's `initialize`.
        const response = await post(
            second.url,
            {
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: { name: 'ping', arguments: {} },
            },
            { Authorization: `Bearer ${TOKEN}`, 'MCP-Protocol-Version': '2025-06-18' },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-session-id')).toBeNull();
        const body = await readJsonRpc(response);
        expect(body).toMatchObject({
            id: 7,
            result: { structuredContent: { status: 'ok', uptime_seconds: 42 } },
        });
    });

    it('keeps nothing of one caller for the next', async () => {
        const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
        const headers = (token: string) => ({
            ...bearer(token),
            'MCP-Protocol-Version': '2025-06-18',
        });
        const call = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'ping', arguments: {} },
        };

        await readJsonRpc(await post(first.url, INITIALIZE, bearer('token-of-alice')));
        await readJsonRpc(await post(first.url, call, headers('token-of-alice')));
        await readJsonRpc(await post(first.url, call, headers('token-of-bob')));

        expect(api.calls.map((made) => made.headers.authorization)).toEqual([
            'Bearer token-of-alice',
            'Bearer token-of-bob',
        ]);
    });
});
