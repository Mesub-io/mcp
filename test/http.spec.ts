import { MAX_REQUEST_BODY_BYTES } from '../src/server.js';
import { SERVER_NAME, VERSION } from '../src/version.js';
import { INITIALIZE, post, readJsonRpc, startServer, TOKEN, type TestServer } from './helpers.js';

describe('the HTTP surface', () => {
    let server: TestServer;
    beforeAll(async () => {
        server = await startServer();
    });
    afterAll(() => server.stop());

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

    describe('the auth seam, as it stands before #2', () => {
        it.each([
            ['no Authorization header', {}],
            ['an empty bearer', { Authorization: 'Bearer ' }],
            ['another scheme', { Authorization: 'Basic dXNlcjpwYXNz' }],
            ['a token that is not one', { Authorization: 'Bearer a b' }],
        ])('refuses %s with 401 and a JSON-RPC error', async (_case, headers) => {
            const response = await post(server.url, INITIALIZE, headers);

            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toBe('Bearer');
            expect(await response.json()).toEqual({
                jsonrpc: '2.0',
                error: { code: -32000, message: expect.stringContaining('bearer token') },
                id: null,
            });
        });

        it('does not read a token from the URL', async () => {
            const response = await fetch(`${server.url}/mcp?access_token=${TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(INITIALIZE),
            });
            expect(response.status).toBe(401);
        });

        it('lets any bearer token through, unverified', async () => {
            const response = await post(server.url, INITIALIZE, {
                Authorization: 'Bearer anything-at-all',
            });

            expect(response.status).toBe(200);
            expect(await readJsonRpc(response)).toMatchObject({
                jsonrpc: '2.0',
                id: 1,
                result: { serverInfo: { name: SERVER_NAME, version: VERSION } },
            });
        });

        it('takes the scheme in any casing', async () => {
            const response = await post(server.url, INITIALIZE, {
                Authorization: `bearer ${TOKEN}`,
            });
            expect(response.status).toBe(200);
        });
    });

    describe('the Origin header', () => {
        it('lets a request without one through: only browsers send it', async () => {
            expect((await post(server.url, INITIALIZE, bearer)).status).toBe(200);
        });

        it.each(['https://evil.example.com', 'null', 'not an origin'])(
            'refuses %s with 403, before looking at the token',
            async (origin) => {
                const response = await post(server.url, INITIALIZE, { ...bearer, Origin: origin });

                expect(response.status).toBe(403);
                expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: null });
                expect(response.headers.get('access-control-allow-origin')).toBeNull();
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
            expect(refused.headers.get('access-control-allow-origin')).toBeNull();
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
        });
    });

    describe('hosted, behind a public URL', () => {
        let hosted: TestServer;
        beforeAll(async () => {
            hosted = await startServer({
                MCP_PUBLIC_URL: 'https://mcp.example.com',
                MCP_ALLOWED_ORIGINS: 'app.example.com',
            });
        });
        afterAll(() => hosted.stop());

        it.each(['https://mcp.example.com', 'https://app.example.com'])(
            'lets %s through',
            async (origin) => {
                const response = await post(hosted.url, INITIALIZE, { ...bearer, Origin: origin });
                expect(response.status).toBe(200);
            },
        );

        it.each(['http://localhost:5173', 'https://evil.example.com'])(
            'refuses %s',
            async (origin) => {
                const response = await post(hosted.url, INITIALIZE, { ...bearer, Origin: origin });
                expect(response.status).toBe(403);
            },
        );
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
