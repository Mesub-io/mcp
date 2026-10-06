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

const statusesOf = async (responses: Promise<Response>[]) =>
    (await Promise.all(responses)).map((response) => response.status);
const count = (statuses: number[], status: number) =>
    statuses.filter((one) => one === status).length;

/*
 * The rule these tests hold the limits to: a limit protects the Mesub API
 * from a flood, and is never a way for one caller to keep another out. Every
 * scenario named after a letter is one a security review proved against the
 * first design, where a budget per address was spent before the verdict.
 */
describe('limits, in the memory of one instance', () => {
    let api: FakeApi;
    let server: TestServer;
    let now: number;

    beforeEach(async () => {
        // Frozen at the present: the fake API dates a token's expiry by the real clock.
        now = Date.now();
        api = await fakeMesubApi();
        server = await startServer({ MESUB_API_URL: api.url }, { now: () => now });
    });
    afterEach(async () => {
        await server.stop();
        await api.close();
    });

    describe('nobody is kept out by what somebody else sent from the same address', () => {
        it('B: lets a valid token in after 30 made-up tokens, and during 300 more', async () => {
            const flood = Array.from({ length: 30 }, (_, i) =>
                callTool(server.url, 'ping', {}, bearer(`mat_made-up-${i}`)),
            );
            expect(count(await statusesOf(flood), 401)).toBe(30);

            // A token this instance has never seen, from the very same address.
            api.issue('mat_neighbour', { connection_id: 'conn_neighbour' });
            expect((await callTool(server.url, 'ping', {}, bearer('mat_neighbour'))).status).toBe(
                200,
            );

            // And while a flood is in flight, not only after it.
            api.delayWhoami(20);
            api.issue('mat_newcomer', { connection_id: 'conn_newcomer' });
            const during = Array.from({ length: 60 }, (_, i) =>
                callTool(server.url, 'ping', {}, bearer(`mat_more-${i}`)),
            );
            const seen = callTool(server.url, 'ping', {}, bearer('mat_neighbour'));
            const unseen = callTool(server.url, 'ping', {}, bearer('mat_newcomer'));

            expect((await seen).status).toBe(200);
            expect((await unseen).status).toBe(200);
            expect(count(await statusesOf(during), 401)).toBe(60);
        });

        it('B2: lets a valid token in after one refused token was replayed 30 times', async () => {
            for (let i = 0; i < 30; i++) {
                const response = await callTool(server.url, 'ping', {}, bearer('mat_expired-one'));
                // Always the challenge, so its holder learns to refresh. Never a 429.
                expect(response.status).toBe(401);
                expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
            }

            expect(api.callsTo(WHOAMI)).toHaveLength(1);
            expect((await callTool(server.url, 'ping')).status).toBe(200);
        });

        it('C: one connection past its limit costs another connection nothing', async () => {
            const limited = await startServer(
                { MESUB_API_URL: api.url },
                { now: () => now, limits: { perConnection: 5 } },
            );
            api.issue('mat_other', { connection_id: 'conn_other' });

            const busy: number[] = [];
            for (let i = 0; i < 40; i++) busy.push((await callTool(limited.url, 'ping')).status);

            expect(busy.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
            expect(busy.slice(5).every((status) => status === 429)).toBe(true);
            // Past its limit, a token already seen is refused without asking the API.
            expect(api.callsTo(WHOAMI)).toHaveLength(5);

            const other = await callTool(limited.url, 'ping', {}, bearer('mat_other'));
            expect(other.status).toBe(200);
            await limited.stop();
        });

        it('D: an outage of the API is not held against anybody once it is over', async () => {
            api.whoami({ status: 503, body: {} });
            for (let i = 0; i < 40; i++)
                expect((await callTool(server.url, 'ping')).status).toBe(503);

            api.whoami();
            expect((await callTool(server.url, 'ping')).status).toBe(200);
            // Nor against the connection: every one of its 120 is still there.
            for (let i = 0; i < 119; i++) {
                expect((await callTool(server.url, 'search_docs', { query: 'plan' })).status).toBe(
                    200,
                );
            }
        });

        it('A: one valid client with 60 requests in flight gets 60 answers', async () => {
            api.delayWhoami(100);
            api.issue('mat_fresh', { connection_id: 'conn_fresh' });

            // A token never seen: the first requests open the way for the rest.
            const fresh = Array.from({ length: 60 }, () =>
                callTool(server.url, 'search_docs', { query: 'plan' }, bearer('mat_fresh')),
            );
            expect(count(await statusesOf(fresh), 200)).toBe(60);

            // And one already seen: nothing waits at all.
            const started = Date.now();
            const known = Array.from({ length: 60 }, () =>
                callTool(server.url, 'search_docs', { query: 'plan' }, bearer('mat_fresh')),
            );
            expect(count(await statusesOf(known), 200)).toBe(60);
            expect(Date.now() - started).toBeLessThan(1500);
        });

        it('never answers a request without a token with 429, however many came before', async () => {
            const statuses: number[] = [];
            for (let i = 0; i < 150; i++)
                statuses.push((await post(server.url, INITIALIZE)).status);
            for (let i = 0; i < 50; i++) {
                statuses.push((await post(server.url, INITIALIZE, bearer(`SUB_${i}`))).status);
            }

            // The answer costs nothing, and a client that has no token yet needs it.
            expect(count(statuses, 401)).toBe(200);
            expect(api.calls).toHaveLength(0);
            expect((await post(server.url, INITIALIZE)).headers.get('www-authenticate')).toBe(
                CHALLENGE,
            );
        });

        it('stops writing a line per refusal instead, and says so once', async () => {
            for (let i = 0; i < 150; i++) await post(server.url, INITIALIZE);

            const refused = server.logs.filter((line) => line.message === 'request refused');
            const paused = server.logs.filter((line) => line.message === 'log lines held back');
            expect(refused).toHaveLength(60);
            expect(paused).toHaveLength(1);
            expect(paused[0]).toMatchObject({ level: 'warn', address: '127.0.0.1' });

            now += MINUTE;
            await post(server.url, INITIALIZE);
            expect(server.logs.filter((line) => line.message === 'request refused')).toHaveLength(
                61,
            );
        });
    });

    describe('what a flood of made-up tokens costs the Mesub API', () => {
        it('is a bounded number of checks in flight for one address, the rest wait', async () => {
            const bounded = await startServer(
                { MESUB_API_URL: api.url },
                { limits: { checksPerAddress: 3, waitingPerAddress: 500 } },
            );
            const release = api.holdWhoami();
            const flood = Array.from({ length: 40 }, (_, i) =>
                callTool(bounded.url, 'ping', {}, bearer(`mat_fake-${i}`)),
            );

            await vi.waitFor(() => expect(api.callsTo(WHOAMI)).toHaveLength(3));
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect(api.callsTo(WHOAMI)).toHaveLength(3);

            release();
            // Each gets its verdict: none was refused for the others' sake.
            expect(count(await statusesOf(flood), 401)).toBe(40);
            expect(api.callsTo(WHOAMI)).toHaveLength(40);
            await bounded.stop();
        });

        it('sheds what waited too long with 503 and Retry-After, never with a verdict', async () => {
            const impatient = await startServer(
                { MESUB_API_URL: api.url },
                { limits: { checksPerAddress: 2, maxWaitMs: 60 } },
            );
            const release = api.holdWhoami();
            const flood = Array.from({ length: 6 }, (_, i) =>
                callTool(impatient.url, 'ping', {}, bearer(`mat_fake-${i}`)),
            );
            const shed = await Promise.all(flood.slice(2));

            for (const response of shed) {
                expect(response.status).toBe(503);
                expect(response.headers.get('retry-after')).toBe('1');
                expect(response.headers.get('www-authenticate')).toBeNull();
            }
            expect(api.callsTo(WHOAMI)).toHaveLength(2);
            expect(impatient.logs).toContainEqual(
                expect.objectContaining({ message: 'checks shed', level: 'warn' }),
            );

            release();
            expect(count(await statusesOf(flood.slice(0, 2)), 401)).toBe(2);
            // Nothing is held against the address afterwards.
            expect((await callTool(impatient.url, 'ping')).status).toBe(200);
            await impatient.stop();
        });

        it('sheds at once past the room there is to wait in', async () => {
            const small = await startServer(
                { MESUB_API_URL: api.url },
                { limits: { checksPerAddress: 1, waitingPerAddress: 2 } },
            );
            const release = api.holdWhoami();
            const flood = Array.from({ length: 10 }, (_, i) =>
                callTool(small.url, 'ping', {}, bearer(`mat_fake-${i}`)),
            );
            await vi.waitFor(() => expect(api.callsTo(WHOAMI)).toHaveLength(1));
            await new Promise((resolve) => setTimeout(resolve, 50));
            release();

            const statuses = await statusesOf(flood);
            expect(count(statuses, 401)).toBe(3);
            expect(count(statuses, 503)).toBe(7);
            await small.stop();
        });

        it('does not make a token already seen wait behind the flood', async () => {
            const bounded = await startServer(
                { MESUB_API_URL: api.url },
                { limits: { checksPerAddress: 1, checksTotal: 1 } },
            );
            expect((await callTool(bounded.url, 'ping')).status).toBe(200);

            // The one place there is for unseen tokens is taken, and held.
            const release = api.holdWhoami();
            const stuck = callTool(bounded.url, 'ping', {}, bearer('mat_fake'));
            await vi.waitFor(() => expect(api.callsTo(WHOAMI)).toHaveLength(2));

            const seen = callTool(bounded.url, 'ping');
            await vi.waitFor(() => expect(api.callsTo(WHOAMI)).toHaveLength(3));
            release();

            expect((await seen).status).toBe(200);
            expect((await stuck).status).toBe(401);
            await bounded.stop();
        });

        it('asks about one replayed token once per short memory, not once per request', async () => {
            for (let i = 0; i < 100; i++)
                await callTool(server.url, 'ping', {}, bearer('mat_fake'));
            expect(api.callsTo(WHOAMI)).toHaveLength(1);
        });
    });

    describe('H3: many addresses', () => {
        it('cannot keep an address never seen before out, whatever their number', async () => {
            const crowded = await startServer(
                { MESUB_API_URL: api.url, CLIENT_IP_HEADER: 'fly-client-ip' },
                { limits: { maxKeys: 50, logLinesPerAddress: 2 } },
            );
            const from = (address: string) => ({ 'Fly-Client-IP': address });

            // Far more addresses than any table here holds, each sending what it can.
            for (let i = 0; i < 300; i++) {
                const address = `2001:db8:${i.toString(16)}::1`;
                await post(crowded.url, INITIALIZE, from(address));
                await callTool(
                    crowded.url,
                    'ping',
                    {},
                    {
                        ...bearer(`mat_fake-${i}`),
                        ...from(address),
                    },
                );
            }

            const stranger = from('192.0.2.55');
            const anonymous = await post(crowded.url, INITIALIZE, stranger);
            expect(anonymous.status).toBe(401);
            expect(anonymous.headers.get('www-authenticate')).toBe(CHALLENGE);
            expect(
                (await callTool(crowded.url, 'ping', {}, { ...bearer(), ...stranger })).status,
            ).toBe(200);

            // The tables dropped their oldest keys, and the log says that, naming nobody.
            const full = crowded.logs.filter((line) => line.message === 'limiter full');
            expect(full.length).toBeGreaterThan(0);
            expect(full.length).toBeLessThan(10);
            expect(JSON.stringify(full)).not.toContain('192.0.2.55');
            await crowded.stop();
        });

        it('bounds the checks in flight for the whole instance, in turns between addresses', async () => {
            const bounded = await startServer(
                { MESUB_API_URL: api.url, CLIENT_IP_HEADER: 'fly-client-ip' },
                { limits: { checksPerAddress: 2, checksTotal: 4 } },
            );
            const release = api.holdWhoami();
            const flood = Array.from({ length: 60 }, (_, i) =>
                callTool(
                    bounded.url,
                    'ping',
                    {},
                    {
                        ...bearer(`mat_fake-${i}`),
                        'Fly-Client-IP': `198.51.100.${i % 20}`,
                    },
                ),
            );
            await vi.waitFor(() => expect(api.callsTo(WHOAMI)).toHaveLength(4));
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect(api.callsTo(WHOAMI)).toHaveLength(4);

            // A newcomer from an address of its own waits its turn, and gets it.
            api.issue('mat_newcomer', { connection_id: 'conn_newcomer' });
            const newcomer = callTool(
                bounded.url,
                'ping',
                {},
                {
                    ...bearer('mat_newcomer'),
                    'Fly-Client-IP': '192.0.2.77',
                },
            );
            release();

            expect((await newcomer).status).toBe(200);
            expect(count(await statusesOf(flood), 401)).toBe(60);
            await bounded.stop();
        });
    });

    describe('per connection, for requests let in', () => {
        let limited: TestServer;
        beforeEach(async () => {
            limited = await startServer(
                { MESUB_API_URL: api.url },
                { now: () => now, limits: { perConnection: 5 } },
            );
        });
        afterEach(() => limited.stop());

        const rateLimited = () =>
            limited.logs
                .filter((line) => line.message === 'rate limited')
                .map((line) => line.limit);

        it('answers 429 with Retry-After past the limit, for that connection only', async () => {
            api.issue('mat_other', { connection_id: 'conn_other' });

            for (let i = 0; i < 5; i++)
                expect((await callTool(limited.url, 'ping')).status).toBe(200);
            now += 20_000;
            const response = await callTool(limited.url, 'ping');

            expect(response.status).toBe(429);
            expect(response.headers.get('retry-after')).toBe('40');
            expect(response.headers.get('www-authenticate')).toBeNull();
            expect(await response.json()).toEqual({
                error: 'too_many_requests',
                error_description: expect.any(String),
            });
            expect(rateLimited()).toEqual(['connection']);
            expect(api.callsTo('/health')).toHaveLength(5);

            expect((await callTool(limited.url, 'ping', {}, bearer('mat_other'))).status).toBe(200);
        });

        it('counts two tokens of one connection together', async () => {
            // A refreshed token is another token of the same connection.
            api.issue('mat_refreshed', { connection_id: 'conn_1' });

            for (let i = 0; i < 3; i++) await callTool(limited.url, 'ping');
            for (let i = 0; i < 2; i++) {
                await callTool(limited.url, 'ping', {}, bearer('mat_refreshed'));
            }

            expect((await callTool(limited.url, 'ping', {}, bearer('mat_refreshed'))).status).toBe(
                429,
            );
        });

        it('starts again with the next minute', async () => {
            for (let i = 0; i < 6; i++) await callTool(limited.url, 'ping');
            now += MINUTE;
            expect((await callTool(limited.url, 'ping')).status).toBe(200);
        });

        it('still refuses a token revoked while its connection was over the limit', async () => {
            for (let i = 0; i < 6; i++) await callTool(limited.url, 'ping');
            api.revoke(TOKEN);

            // Over the limit it is refused either way, and never let in.
            expect((await callTool(limited.url, 'ping')).status).toBe(429);
            now += MINUTE;
            expect((await callTool(limited.url, 'ping')).status).toBe(401);
        });
    });

    it('is per instance: a second one counts apart', async () => {
        const limits = { perConnection: 2 };
        const one = await startServer({ MESUB_API_URL: api.url }, { limits });
        const two = await startServer({ MESUB_API_URL: api.url }, { limits });

        for (let i = 0; i < 3; i++) await callTool(one.url, 'ping');
        expect((await callTool(one.url, 'ping')).status).toBe(429);
        expect((await callTool(two.url, 'ping')).status).toBe(200);

        await one.stop();
        await two.stop();
    });
});

describe('H2: an API that rate-limits the tokens it does not know, all together', () => {
    it('never passes for a rate limit of ours, and the holder of an expired token still learns it', async () => {
        const api = await fakeMesubApi();
        const server = await startServer({
            MESUB_API_URL: api.url,
            CLIENT_IP_HEADER: 'fly-client-ip',
        });
        // One bucket for every token that stands for none, as the API had it.
        let unresolved = 0;
        let budget = 20;
        api.intercept((req, res) => {
            const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
            if (req.url !== WHOAMI || api.knows(token)) return false;
            if (++unresolved <= budget) return false;
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
            res.end(JSON.stringify({ statusCode: 429, code: 'rate_limited', message: 'Too many' }));
            return true;
        });

        // Strangers, from addresses of their own, spend that bucket.
        for (let i = 0; i < 30; i++) {
            await callTool(
                server.url,
                'ping',
                {},
                {
                    ...bearer(`mat_junk-${i}`),
                    'Fly-Client-IP': `198.51.100.${i % 5}`,
                },
            );
        }

        const honest = { ...bearer('mat_past-its-hour'), 'Fly-Client-IP': '192.0.2.1' };
        const held = await callTool(server.url, 'ping', {}, honest);
        // Our capacity problem, said as one: not a 429, and nothing to do but wait a little.
        expect(held.status).toBe(503);
        expect(Number(held.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(Number(held.headers.get('retry-after'))).toBeLessThanOrEqual(60);
        expect(held.headers.get('www-authenticate')).toBeNull();
        expect(server.logs).toContainEqual(
            expect.objectContaining({
                level: 'error',
                message: 'cannot check access tokens',
                reason: 'api_rate_limited',
            }),
        );

        // A live token is not concerned at any moment.
        const live = await callTool(
            server.url,
            'ping',
            {},
            {
                ...bearer(),
                'Fly-Client-IP': '192.0.2.2',
            },
        );
        expect(live.status).toBe(200);

        // The API lets the check through: nothing was remembered against the token.
        budget = Number.POSITIVE_INFINITY;
        const told = await callTool(server.url, 'ping', {}, honest);
        expect(told.status).toBe(401);
        expect(told.headers.get('www-authenticate')).toBe(CHALLENGE);

        await server.stop();
        await api.close();
    });
});

describe('the client address', () => {
    let api: FakeApi;
    beforeEach(async () => {
        api = await fakeMesubApi();
    });
    afterEach(() => api.close());

    const addresses = (server: TestServer) => [
        ...new Set(
            server.logs
                .filter((line) => line.message === 'request refused')
                .map((line) => line.address),
        ),
    ];

    it('is the socket peer by default: no header moves a caller elsewhere', async () => {
        const server = await startServer({ MESUB_API_URL: api.url });

        for (let i = 0; i < 4; i++) {
            await post(server.url, INITIALIZE, {
                'X-Forwarded-For': `198.51.100.${i}`,
                'CF-Connecting-IP': `198.51.100.${i}`,
                'Fly-Client-IP': `198.51.100.${i}`,
                'X-Real-IP': `198.51.100.${i}`,
                Forwarded: `for=198.51.100.${i}`,
            });
        }

        expect(addresses(server)).toEqual(['127.0.0.1']);
        await server.stop();
    });

    it('is the configured header behind a proxy, and never X-Forwarded-For', async () => {
        const server = await startServer({
            MESUB_API_URL: api.url,
            CLIENT_IP_HEADER: 'fly-client-ip',
        });

        await post(server.url, INITIALIZE, { 'Fly-Client-IP': '198.51.100.1' });
        await post(server.url, INITIALIZE, {
            'Fly-Client-IP': '198.51.100.1',
            'X-Forwarded-For': '203.0.113.9',
        });
        await post(server.url, INITIALIZE, { 'Fly-Client-IP': '2001:db8:1:2:aaaa::1' });

        expect(addresses(server)).toEqual(['198.51.100.1', '2001:db8:1:2::/64']);
        await server.stop();
    });

    it('E: an address a stranger names cannot be framed: its valid token gets in', async () => {
        const server = await startServer({
            MESUB_API_URL: api.url,
            CLIENT_IP_HEADER: 'cf-connecting-ip',
        });
        const victim = { 'CF-Connecting-IP': '203.0.113.7' };

        for (let i = 0; i < 60; i++) {
            await callTool(server.url, 'ping', {}, { ...bearer(`mat_frame-${i}`), ...victim });
            await post(server.url, INITIALIZE, victim);
        }

        expect((await callTool(server.url, 'ping', {}, { ...bearer(), ...victim })).status).toBe(
            200,
        );
        expect((await post(server.url, INITIALIZE, victim)).status).toBe(401);
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
