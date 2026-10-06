import { request } from 'node:http';

import {
    bearer,
    callTool,
    CHALLENGE,
    fakeMesubApi,
    INITIALIZE,
    post,
    startServer,
    TOKEN,
    type FakeApi,
    type TestServer,
} from './helpers.js';

const WHOAMI = '/agent/whoami';
const MINUTE = 60_000;

describe('rate limits, in the memory of one instance', () => {
    let api: FakeApi;
    let server: TestServer;
    let now: number;

    const limits = { anonymousPerAddress: 4, failedChecksPerAddress: 3, perConnection: 5 };
    const limited = (server: TestServer) =>
        server.logs.filter((line) => line.message === 'rate limited').map((line) => line.limit);

    beforeEach(async () => {
        // Frozen at the present: the fake API dates a token's expiry by the real clock.
        now = Date.now();
        api = await fakeMesubApi();
        server = await startServer({ MESUB_API_URL: api.url }, { limits, now: () => now });
    });
    afterEach(async () => {
        await server.stop();
        await api.close();
    });

    describe('per client address, for requests without a token', () => {
        it('answers 429 with Retry-After past the limit, and no challenge', async () => {
            for (let i = 0; i < 4; i++)
                expect((await post(server.url, INITIALIZE)).status).toBe(401);

            now += 15_000;
            const response = await post(server.url, INITIALIZE);

            expect(response.status).toBe(429);
            expect(response.headers.get('retry-after')).toBe('45');
            expect(response.headers.get('www-authenticate')).toBeNull();
            expect(await response.json()).toEqual({
                error: 'too_many_requests',
                error_description: expect.any(String),
            });
            expect(limited(server)).toEqual(['address_anonymous']);
        });

        it('counts a malformed token like no token, and never asks the API', async () => {
            for (let i = 0; i < 4; i++) await post(server.url, INITIALIZE, bearer(`SUB_${i}`));
            expect((await post(server.url, INITIALIZE)).status).toBe(429);
            expect(api.calls).toHaveLength(0);
        });

        it('leaves a caller holding a valid token alone', async () => {
            for (let i = 0; i < 6; i++) await post(server.url, INITIALIZE);
            expect((await callTool(server.url, 'ping')).status).toBe(200);
        });

        it('starts again with the next minute', async () => {
            for (let i = 0; i < 5; i++) await post(server.url, INITIALIZE);
            now += MINUTE;

            const response = await post(server.url, INITIALIZE);
            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
        });

        it('does not count the metadata nor the health check', async () => {
            for (let i = 0; i < 10; i++) {
                await fetch(`${server.url}/.well-known/oauth-protected-resource`);
                await fetch(`${server.url}/health`);
            }
            expect((await post(server.url, INITIALIZE)).status).toBe(401);
        });
    });

    describe('per client address, for tokens the API is asked about', () => {
        it('turns a flood of made-up tokens into a few calls to the API', async () => {
            const statuses: number[] = [];
            for (let i = 0; i < 40; i++) {
                statuses.push(
                    (await callTool(server.url, 'ping', {}, bearer(`mat_fake-${i}`))).status,
                );
            }

            expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
            expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
            expect(api.callsTo(WHOAMI)).toHaveLength(3);
            expect(limited(server)).toEqual(['address_checks']);
        });

        it('holds under a flood sent all at once', async () => {
            const release = api.holdWhoami();
            const flood = Array.from({ length: 40 }, (_, i) =>
                callTool(server.url, 'ping', {}, bearer(`mat_fake-${i}`)),
            );
            const settled = Promise.all(flood);
            await vi.waitFor(() => expect(api.callsTo(WHOAMI)).toHaveLength(3));
            await new Promise((resolve) => setTimeout(resolve, 50));
            release();

            const statuses = (await settled).map((response) => response.status);
            expect(statuses.filter((status) => status === 401)).toHaveLength(3);
            expect(statuses.filter((status) => status === 429)).toHaveLength(37);
            expect(api.callsTo(WHOAMI)).toHaveLength(3);
        });

        it('does not count a token that was let in', async () => {
            api.issue('mat_second');
            for (let i = 0; i < 4; i++) {
                expect((await callTool(server.url, 'ping')).status).toBe(200);
                expect((await callTool(server.url, 'ping', {}, bearer('mat_second'))).status).toBe(
                    200,
                );
            }
        });

        it('counts a token remembered as refused, without asking the API', async () => {
            for (let i = 0; i < 3; i++) {
                expect((await callTool(server.url, 'ping', {}, bearer('mat_fake'))).status).toBe(
                    401,
                );
            }
            expect((await callTool(server.url, 'ping', {}, bearer('mat_fake'))).status).toBe(429);
            expect(api.callsTo(WHOAMI)).toHaveLength(1);
        });

        it('counts a check the API could not answer: an outage is not hammered', async () => {
            api.whoami({ status: 503, body: {} });
            for (let i = 0; i < 3; i++)
                expect((await callTool(server.url, 'ping')).status).toBe(503);

            expect((await callTool(server.url, 'ping')).status).toBe(429);
            expect(api.callsTo(WHOAMI)).toHaveLength(3);
        });

        it('keeps a valid token out too while the address is over, then lets it back in', async () => {
            for (let i = 0; i < 3; i++)
                await callTool(server.url, 'ping', {}, bearer(`mat_f-${i}`));

            const blocked = await callTool(server.url, 'ping');
            expect(blocked.status).toBe(429);
            expect(blocked.headers.get('retry-after')).toBe('60');

            now += MINUTE;
            expect((await callTool(server.url, 'ping')).status).toBe(200);
        });
    });

    describe('per connection, for requests let in', () => {
        it('answers 429 with Retry-After past the limit, for that connection only', async () => {
            api.issue('mat_other', { connection_id: 'conn_other' });

            for (let i = 0; i < 5; i++)
                expect((await callTool(server.url, 'ping')).status).toBe(200);
            now += 20_000;
            const response = await callTool(server.url, 'ping');

            expect(response.status).toBe(429);
            expect(response.headers.get('retry-after')).toBe('40');
            expect(response.headers.get('www-authenticate')).toBeNull();
            expect(limited(server)).toEqual(['connection']);
            expect(api.callsTo('/health')).toHaveLength(5);

            expect((await callTool(server.url, 'ping', {}, bearer('mat_other'))).status).toBe(200);
        });

        it('counts two tokens of one connection together', async () => {
            // A refreshed token is another token of the same connection.
            api.issue('mat_refreshed', { connection_id: 'conn_1' });

            for (let i = 0; i < 3; i++) await callTool(server.url, 'ping');
            for (let i = 0; i < 2; i++)
                await callTool(server.url, 'ping', {}, bearer('mat_refreshed'));

            expect((await callTool(server.url, 'ping', {}, bearer('mat_refreshed'))).status).toBe(
                429,
            );
        });

        it('stops asking the API for a connection that keeps going over', async () => {
            for (let i = 0; i < 40; i++) await callTool(server.url, 'ping');

            // 5 let in, then 3 more checks counted against the address, then nothing.
            expect(api.callsTo(WHOAMI)).toHaveLength(8);
            expect(api.callsTo('/health')).toHaveLength(5);
        });

        it('starts again with the next minute', async () => {
            for (let i = 0; i < 6; i++) await callTool(server.url, 'ping');
            now += MINUTE;
            expect((await callTool(server.url, 'ping')).status).toBe(200);
        });
    });

    it('is per instance: a second one has budgets of its own', async () => {
        const second = await startServer({ MESUB_API_URL: api.url }, { limits, now: () => now });

        for (let i = 0; i < 5; i++) await post(server.url, INITIALIZE);
        expect((await post(server.url, INITIALIZE)).status).toBe(429);
        expect((await post(second.url, INITIALIZE)).status).toBe(401);

        await second.stop();
    });
});

describe('the client address a limit counts', () => {
    let api: FakeApi;
    beforeEach(async () => {
        api = await fakeMesubApi();
    });
    afterEach(() => api.close());

    const limits = { anonymousPerAddress: 2 };
    const from = (server: TestServer, headers: Record<string, string>) =>
        post(server.url, INITIALIZE, headers);

    it('is the socket peer by default: no header moves a caller to another budget', async () => {
        const server = await startServer({ MESUB_API_URL: api.url }, { limits });

        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) {
            const response = await from(server, {
                'X-Forwarded-For': `198.51.100.${i}`,
                'CF-Connecting-IP': `198.51.100.${i}`,
                'Fly-Client-IP': `198.51.100.${i}`,
                'X-Real-IP': `198.51.100.${i}`,
                Forwarded: `for=198.51.100.${i}`,
            });
            statuses.push(response.status);
        }

        expect(statuses).toEqual([401, 401, 429, 429]);
        await server.stop();
    });

    it('is the configured header behind a proxy, and never X-Forwarded-For', async () => {
        const server = await startServer(
            { MESUB_API_URL: api.url, CLIENT_IP_HEADER: 'fly-client-ip' },
            { limits },
        );
        const alice = { 'Fly-Client-IP': '198.51.100.1' };
        const bob = { 'Fly-Client-IP': '198.51.100.2' };

        expect((await from(server, alice)).status).toBe(401);
        expect((await from(server, alice)).status).toBe(401);
        expect((await from(server, alice)).status).toBe(429);
        expect((await from(server, { ...alice, 'X-Forwarded-For': '203.0.113.9' })).status).toBe(
            429,
        );
        expect((await from(server, bob)).status).toBe(401);
        await server.stop();
    });

    it('never puts an address a client wrote in a header it sends to the API', async () => {
        const server = await startServer({ MESUB_API_URL: api.url });

        // Raw, so nothing between the test and the server rewrites a header.
        const answered = await new Promise<{ status: number; text: string }>((resolve, reject) => {
            const req = request(
                `${server.url}/mcp`,
                {
                    method: 'POST',
                    headers: {
                        ...bearer(),
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'MCP-Protocol-Version': '2025-06-18',
                        'X-Forwarded-For': '203.0.113.9',
                        'X-Mesub-Service-Secret': 'from-the-client',
                        'X-Injected': 'yes',
                        Cookie: 'session=abc',
                    },
                },
                (res) => {
                    let text = '';
                    res.on('data', (chunk: Buffer) => (text += chunk.toString()));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
                },
            );
            req.on('error', reject);
            req.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'ping', arguments: {} },
                }),
            );
        });

        expect(answered.status).toBe(200);
        expect(answered.text).toContain('"uptime_seconds":42');
        expect(api.calls).toHaveLength(2);
        for (const call of api.calls) {
            expect(Object.keys(call.headers).sort()).toEqual(
                [
                    'accept',
                    'accept-encoding',
                    'accept-language',
                    'connection',
                    'host',
                    'mesub-version',
                    'sec-fetch-mode',
                    'user-agent',
                    ...(call.path === WHOAMI ? ['authorization', 'x-mesub-service-secret'] : []),
                ].sort(),
            );
        }
        expect(api.callsTo(WHOAMI)[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
        await server.stop();
    });
});
