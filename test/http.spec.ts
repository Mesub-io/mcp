import { MAX_REQUEST_BODY_BYTES } from '../src/server.js';
import { SERVER_NAME, VERSION } from '../src/version.js';
import {
    fakeMesubApi,
    INITIALIZE,
    post,
    readJsonRpc,
    startServer,
    TOKEN,
    type FakeApi,
    type TestServer,
} from './helpers.js';

describe('the HTTP surface', () => {
    let api: FakeApi;
    let server: TestServer;
    beforeAll(async () => {
        api = await fakeMesubApi();
        server = await startServer({ MESUB_API_URL: api.url });
    });
    afterAll(async () => {
        await server.stop();
        await api.close();
    });

    const bearer = { Authorization: `Bearer ${TOKEN}` };

    describe('GET /health', () => {
        it("answers 200 with the server's name and version, without a token", async () => {
            const response = await fetch(`${server.url}/health`);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                status: 'ok',
                name: SERVER_NAME,
                version: VERSION,
            });
        });
    });

    it('answers 404 in JSON anywhere else', async () => {
        const response = await fetch(`${server.url}/nope`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
    });

    it('answers a request holding a valid token', async () => {
        const response = await post(server.url, INITIALIZE, bearer);

        expect(response.status).toBe(200);
        expect(await readJsonRpc(response)).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            result: { serverInfo: { name: SERVER_NAME, version: VERSION } },
        });
    });

    describe('the Origin header', () => {
        it('lets a request without one through: only browsers send it', async () => {
            expect((await post(server.url, INITIALIZE, bearer)).status).toBe(200);
        });

        it.each(['https://evil.example.com', 'null', 'not an origin'])(
            'refuses %s with 403, before looking at the token',
            async (origin) => {
                const before = api.calls.length;
                const response = await post(server.url, INITIALIZE, { ...bearer, Origin: origin });

                expect(api.calls).toHaveLength(before);
                expect(response.status).toBe(403);
                expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: null });
                // Readable by the page that was refused: it says nothing but "no".
                expect(response.headers.get('access-control-allow-origin')).toBe('*');
                expect(response.headers.get('access-control-allow-credentials')).toBeNull();
            },
        );

        it("lets the server's own origin through, with its CORS headers", async () => {
            const origin = `http://localhost:${server.port}`;
            const response = await post(server.url, INITIALIZE, { ...bearer, Origin: origin });

            expect(response.status).toBe(200);
            expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        });

        it('answers the preflight of an allowed origin, and of no other', async () => {
            const preflight = (origin: string) =>
                fetch(`${server.url}/mcp`, {
                    method: 'OPTIONS',
                    headers: {
                        Origin: origin,
                        'Access-Control-Request-Method': 'POST',
                        'Access-Control-Request-Headers': 'authorization, content-type',
                    },
                });

            const allowed = await preflight('http://localhost:5173');
            expect(allowed.status).toBe(204);
            expect(allowed.headers.get('access-control-allow-origin')).toBe(
                'http://localhost:5173',
            );
            expect(allowed.headers.get('access-control-allow-headers')).toContain('Authorization');

            const refused = await preflight('https://evil.example.com');
            expect(refused.status).toBe(403);
            expect(refused.headers.get('access-control-allow-methods')).toBeNull();
            expect(refused.headers.get('access-control-allow-headers')).toBeNull();
        });

        it.each(['http://localhost:9999', 'http://127.0.0.1:5173', 'https://localhost:8443'])(
            'run locally, lets a page of this machine through on any port: %s',
            async (origin) => {
                const response = await post(server.url, INITIALIZE, { ...bearer, Origin: origin });
                expect(response.status).toBe(200);
            },
        );

        it.each([
            'http://localhost.evil.example.com',
            'http://localhost@evil.example.com',
            'http://evil.example.com#@localhost',
            'file://',
            'chrome-extension://abcdefgh',
            'http://LOCALHOST:5173',
            'http://localhost:5173/',
        ])('run locally, refuses %s', async (origin) => {
            const response = await post(server.url, INITIALIZE, { ...bearer, Origin: origin });
            expect(response.status).toBe(403);
        });

        it('L2: says in its logs that an origin or a host was refused, a few times a minute', async () => {
            const quiet = await startServer(
                { MESUB_API_URL: api.url },
                { limits: { logLinesPerAddress: 3 } },
            );
            for (let i = 0; i < 10; i++) {
                await post(quiet.url, INITIALIZE, { Origin: `https://evil-${i}.example.com` });
            }

            const refused = quiet.logs.filter((line) => line.message === 'origin refused');
            expect(refused).toHaveLength(3);
            expect(refused[0]).toMatchObject({
                level: 'warn',
                address: '127.0.0.1',
                origin: 'https://evil-0.example.com',
            });
            await quiet.stop();
        });

        it('L2: never writes an Origin as it came when it is not one', async () => {
            await post(server.url, INITIALIZE, {
                ...bearer,
                Origin: `not an origin ${TOKEN} ${'x'.repeat(500)}`,
            });

            const line = server.logs.filter((entry) => entry.message === 'origin refused').at(-1);
            expect(line?.origin).toMatch(/^\[not an origin, \d+ characters\]$/);
            expect(server.lines.join('\n')).not.toContain(TOKEN);
        });

        it('refuses a Host that is not this machine when run locally', async () => {
            // fetch does not let a Host be set: the raw client does.
            const { request } = await import('node:http');
            const status = await new Promise<number>((resolve, reject) => {
                const req = request(
                    `${server.url}/mcp`,
                    {
                        method: 'POST',
                        headers: { ...bearer, Host: 'rebound.example.com' },
                    },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode ?? 0);
                    },
                );
                req.on('error', reject);
                req.end(JSON.stringify(INITIALIZE));
            });

            expect(status).toBe(403);
            expect(server.logs).toContainEqual(
                expect.objectContaining({ level: 'warn', message: 'host refused' }),
            );
        });
    });

    describe('hosted, behind a public URL', () => {
        let hosted: TestServer;
        beforeAll(async () => {
            api.issue(TOKEN, { audience: 'https://mcp.example.com/mcp' });
            hosted = await startServer({
                MESUB_API_URL: api.url,
                MCP_PUBLIC_URL: 'https://mcp.example.com',
                MCP_ALLOWED_ORIGINS: 'https://app.example.com, https://admin.example.com:8443',
            });
        });
        afterAll(async () => {
            await hosted.stop();
            api.issue(TOKEN);
        });

        it.each([
            'https://mcp.example.com',
            'https://app.example.com',
            'https://admin.example.com:8443',
        ])('lets %s through', async (origin) => {
            const response = await post(hosted.url, INITIALIZE, { ...bearer, Origin: origin });
            expect(response.status).toBe(200);
            expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        });

        it.each([
            // L2: the scheme and the port are part of an origin.
            'http://mcp.example.com',
            'https://mcp.example.com:8443',
            'http://mcp.example.com:8080',
            'http://app.example.com',
            'https://app.example.com:444',
            'https://admin.example.com',
            'https://admin.example.com:443',
            'https://MCP.EXAMPLE.COM',
            'https://mcp.example.com.evil.example.com',
            'http://localhost:5173',
            'http://127.0.0.1',
            'https://evil.example.com',
            'null',
        ])('refuses %s', async (origin) => {
            const before = api.calls.length;
            const response = await post(hosted.url, INITIALIZE, { ...bearer, Origin: origin });
            expect(response.status).toBe(403);
            expect(api.calls).toHaveLength(before);
        });

        it('refuses the preflight of a page on another port or scheme', async () => {
            for (const origin of ['http://mcp.example.com', 'https://app.example.com:444']) {
                const response = await fetch(`${hosted.url}/mcp`, {
                    method: 'OPTIONS',
                    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
                });
                expect(response.status).toBe(403);
            }
        });
    });

    describe('what the transport does not keep', () => {
        it.each(['GET', 'DELETE'])(
            'answers 405 to %s /mcp: no stream, no session',
            async (method) => {
                const response = await fetch(`${server.url}/mcp`, {
                    method,
                    headers: { ...bearer, Accept: 'text/event-stream' },
                });
                expect(response.status).toBe(405);
            },
        );

        it('issues no session id', async () => {
            const response = await post(server.url, INITIALIZE, bearer);
            expect(response.headers.get('mcp-session-id')).toBeNull();
        });
    });

    describe('the request body', () => {
        it('is not read before the token is checked', async () => {
            const body = JSON.stringify({
                ...INITIALIZE,
                padding: 'x'.repeat(MAX_REQUEST_BODY_BYTES),
            });
            expect((await post(server.url, body)).status).toBe(401);
        });

        it('refuses one past the limit with 413', async () => {
            const body = JSON.stringify({
                ...INITIALIZE,
                padding: 'x'.repeat(MAX_REQUEST_BODY_BYTES),
            });
            const response = await post(server.url, body, bearer);
            expect(response.status).toBe(413);
        });

        it('refuses one that is not JSON, without a stack trace', async () => {
            const response = await post(server.url, '{not json', bearer);

            expect(response.status).toBe(400);
            const text = await response.text();
            expect(text).not.toMatch(/\bat \S+ \(|node_modules|\.ts:\d+/);
        });
    });

    it('never logs the token, whatever was asked', async () => {
        await post(server.url, INITIALIZE, bearer);
        await post(server.url, '{not json', bearer);
        await post(server.url, { jsonrpc: '2.0', id: 9, method: 'nope' }, bearer);

        expect(server.lines.length).toBeGreaterThan(0);
        expect(server.lines.join('\n')).not.toContain(TOKEN);
    });
});
