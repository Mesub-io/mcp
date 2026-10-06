import {
    discoverOAuthProtectedResourceMetadata,
    extractWWWAuthenticateParams,
} from '@modelcontextprotocol/client';
import * as z from 'zod';

import { REFUSED_TOKEN_TTL_MS } from '../src/rate-limit.js';
import { defineTool, type ToolContext } from '../src/tools/tool.js';
import {
    bearer,
    callTool,
    CHALLENGE,
    deadUrl,
    fakeMesubApi,
    INITIALIZE,
    METADATA_URL,
    post,
    PUBLIC_URL,
    readJsonRpc,
    RESOURCE,
    SERVICE_SECRET,
    startServer,
    TOKEN,
    type FakeApi,
    type TestServer,
} from './helpers.js';

const WHOAMI = '/agent/whoami';

const reasons = (server: TestServer, message: string) =>
    server.logs.filter((line) => line.message === message).map((line) => line.reason);

describe('authorization', () => {
    let api: FakeApi;
    let server: TestServer;

    beforeEach(async () => {
        api = await fakeMesubApi();
        server = await startServer({ MESUB_API_URL: api.url });
    });
    afterEach(async () => {
        await server.stop();
        await api.close();
    });

    describe('the protected resource metadata (RFC 9728)', () => {
        const document = () => ({ resource: RESOURCE, authorization_servers: [api.url] });

        it.each([
            ['the path of the MCP endpoint', '/.well-known/oauth-protected-resource/mcp'],
            ['the root', '/.well-known/oauth-protected-resource'],
        ])('is served at %s, without a token, to any origin', async (_where, path) => {
            const response = await fetch(`${server.url}${path}`, {
                headers: { Origin: 'https://anywhere.example.com' },
            });

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');
            expect(response.headers.get('access-control-allow-origin')).toBe('*');
            expect(await response.json()).toEqual(document());
            expect(api.calls).toHaveLength(0);
        });

        it('answers HEAD and a preflight, and no other method', async () => {
            const url = `${server.url}/.well-known/oauth-protected-resource/mcp`;

            const head = await fetch(url, { method: 'HEAD' });
            expect(head.status).toBe(200);
            expect(await head.text()).toBe('');

            const preflight = await fetch(url, { method: 'OPTIONS' });
            expect(preflight.status).toBe(204);
            expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

            const written = await fetch(url, { method: 'POST', body: '{}' });
            expect(written.status).toBe(405);
            expect(written.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
        });

        it('is not the authorization server: it serves none of its metadata', async () => {
            for (const path of [
                '/.well-known/oauth-authorization-server',
                '/.well-known/oauth-authorization-server/mcp',
                '/.well-known/openid-configuration',
                '/.well-known/oauth-protected-resource/other',
            ]) {
                expect((await fetch(`${server.url}${path}`)).status).toBe(404);
            }
        });

        it('names the canonical resource and the issuer as configured, hosted', async () => {
            const hosted = await startServer({
                MESUB_API_URL: api.url,
                MCP_PUBLIC_URL: 'https://MCP.Example.com/',
                MESUB_ISSUER_URL: 'https://api.example.com',
            });

            const response = await fetch(`${hosted.url}/.well-known/oauth-protected-resource/mcp`);
            expect(await response.json()).toEqual({
                resource: 'https://mcp.example.com/mcp',
                authorization_servers: ['https://api.example.com'],
            });

            const refused = await post(hosted.url, INITIALIZE);
            expect(refused.headers.get('www-authenticate')).toContain(
                'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
            );
            await hosted.stop();
        });

        it("is what the SDK's client finds from the 401, by itself", async () => {
            const refused = await post(server.url, INITIALIZE);
            const { resourceMetadataUrl, error } = extractWWWAuthenticateParams(refused);

            expect(error).toBe('invalid_token');
            expect(resourceMetadataUrl?.href).toBe(METADATA_URL);

            // The public URL is not where the test server listens: sent there.
            const rerouted: typeof fetch = (input, init) => {
                const url = new URL(input instanceof Request ? input.url : input);
                expect(url.origin).toBe(PUBLIC_URL);
                return fetch(`${server.url}${url.pathname}`, init);
            };
            const found = await discoverOAuthProtectedResourceMetadata(
                RESOURCE,
                { ...(resourceMetadataUrl && { resourceMetadataUrl }) },
                rerouted,
            );
            expect(found).toMatchObject(document());

            // And without the header, from the well-known paths alone.
            const probed = await discoverOAuthProtectedResourceMetadata(RESOURCE, {}, rerouted);
            expect(probed).toMatchObject(document());
        });
    });

    describe('the 401', () => {
        const refusedBody = {
            error: 'invalid_token',
            error_description: 'A valid Mesub access token is required.',
        };

        it.each([
            ['no Authorization header', {}, 'no_token', 0],
            ['an empty bearer', { Authorization: 'Bearer ' }, 'malformed_token', 0],
            ['another scheme', { Authorization: 'Basic dXNlcjpwYXNz' }, 'malformed_token', 0],
            ['two tokens', { Authorization: `Bearer ${TOKEN} ${TOKEN}` }, 'malformed_token', 0],
            [
                'a header sent twice',
                { Authorization: `Bearer ${TOKEN}, Bearer ${TOKEN}` },
                'malformed_token',
                0,
            ],
            ['a token Mesub never issues', bearer('SUB_an_api_key'), 'malformed_token', 0],
            ['an endless token', bearer(`mat_${'a'.repeat(600)}`), 'malformed_token', 0],
            ['a token of the wrong alphabet', bearer('mat_a/b+c=='), 'malformed_token', 0],
            ['a token nobody was issued', bearer('mat_made-up'), 'refused_token', 1],
        ])(
            'answers %s with the challenge, and says which in its logs only',
            async (_case, headers, reason, checks) => {
                const response = await post(server.url, INITIALIZE, headers);

                expect(response.status).toBe(401);
                expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
                expect(await response.json()).toEqual(refusedBody);
                expect(reasons(server, 'request refused')).toEqual([reason]);
                expect(api.callsTo(WHOAMI)).toHaveLength(checks);
            },
        );

        it('answers an expired token and a revoked one the same way', async () => {
            api.issue('mat_expired', { expires_at: Math.floor(Date.now() / 1000) - 1 });
            api.issue('mat_revoked');
            api.revoke('mat_revoked');

            for (const token of ['mat_expired', 'mat_revoked']) {
                const response = await post(server.url, INITIALIZE, bearer(token));
                expect(response.status).toBe(401);
                expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
                expect(await response.json()).toEqual(refusedBody);
            }
        });

        it('refuses a 200 whose token is past its hour by our own clock', async () => {
            api.whoami({
                status: 200,
                body: { ...api.issue('mat_late'), expires_at: Math.floor(Date.now() / 1000) - 5 },
            });

            const response = await post(server.url, INITIALIZE, bearer('mat_late'));
            expect(response.status).toBe(401);
            expect(reasons(server, 'request refused')).toEqual(['expired_token']);
        });

        it('does not read a token from the URL, nor from the body', async () => {
            const response = await fetch(`${server.url}/mcp?access_token=${TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...INITIALIZE, access_token: TOKEN }),
            });
            expect(response.status).toBe(401);
            expect(api.calls).toHaveLength(0);
        });

        it('takes the scheme in any casing', async () => {
            const response = await post(server.url, INITIALIZE, {
                Authorization: `bearer ${TOKEN}`,
            });
            expect(response.status).toBe(200);
        });

        it.each(['GET', 'DELETE'])('comes before the 405 of %s /mcp', async (method) => {
            const response = await fetch(`${server.url}/mcp`, { method });
            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
        });

        it('lets a browser read the challenge', async () => {
            const origin = 'http://localhost:5173';
            const response = await post(server.url, INITIALIZE, { Origin: origin });

            expect(response.status).toBe(401);
            expect(response.headers.get('access-control-allow-origin')).toBe(origin);
            expect(response.headers.get('access-control-expose-headers')).toMatch(
                /WWW-Authenticate/i,
            );
        });
    });

    describe('every request to /mcp needs a valid token', () => {
        const methods = [
            ['initialize', INITIALIZE],
            ['server/discover', { jsonrpc: '2.0', id: 1, method: 'server/discover' }],
            ['ping', { jsonrpc: '2.0', id: 1, method: 'ping' }],
            ['tools/list', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
            [
                'tools/call of search_docs',
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'search_docs', arguments: { query: 'hasAccess' } },
                },
            ],
            ['a notification', { jsonrpc: '2.0', method: 'notifications/initialized' }],
            ['a body that is not JSON', '{not json'],
        ] as const;

        it.each(methods)('refuses %s without one, unread', async (_name, body) => {
            const response = await post(server.url, body, {
                'MCP-Protocol-Version': '2025-06-18',
            });

            expect(response.status).toBe(401);
            expect(await response.text()).not.toMatch(/docs\.mesub\.io|serverInfo|tools/);
        });

        it.each(methods)('checks the token of %s with the API', async (_name, body) => {
            await post(server.url, body, { ...bearer(), 'MCP-Protocol-Version': '2025-06-18' });
            expect(api.callsTo(WHOAMI)).toHaveLength(1);
        });
    });

    describe('the check with the Mesub API', () => {
        it('sends the token and the service secret together, once per request', async () => {
            const response = await callTool(server.url, 'search_docs', { query: 'hasAccess' });
            expect(response.status).toBe(200);

            expect(api.calls).toHaveLength(1);
            expect(api.calls[0]).toMatchObject({ method: 'GET', path: WHOAMI });
            expect(api.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
            expect(api.calls[0]?.headers['x-mesub-service-secret']).toBe(SERVICE_SECRET);
        });

        it('takes a revoke into account on the very next request', async () => {
            expect((await callTool(server.url, 'ping')).status).toBe(200);
            expect((await callTool(server.url, 'ping')).status).toBe(200);

            api.revoke(TOKEN);

            const response = await callTool(server.url, 'ping');
            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
            // Every request asked the API: nothing vouched for the token in between.
            expect(api.callsTo(WHOAMI)).toHaveLength(3);
            expect(api.callsTo('/health')).toHaveLength(2);
        });

        it.each([
            ['the audience of another MCP server', { audience: 'https://other.example.com/mcp' }],
            ['the audience without its path', { audience: PUBLIC_URL }],
            ['an audience with a trailing slash', { audience: `${RESOURCE}/` }],
        ])('refuses a live token with %s, even on a 200', async (_case, overrides) => {
            api.issue('mat_elsewhere', overrides);

            const response = await callTool(server.url, 'ping', {}, bearer('mat_elsewhere'));

            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
            expect(reasons(server, 'request refused')).toEqual(['audience_mismatch']);
            expect(api.callsTo('/health')).toHaveLength(0);
        });

        it('refuses a 200 from an API that is not the issuer it names, with 503', async () => {
            api.issue('mat_other-issuer', { issuer: 'https://rogue.example.com' });

            const response = await callTool(server.url, 'ping', {}, bearer('mat_other-issuer'));

            expect(response.status).toBe(503);
            expect(response.headers.get('www-authenticate')).toBeNull();
            expect(reasons(server, 'cannot check access tokens')).toEqual(['issuer_mismatch']);
            expect(api.callsTo('/health')).toHaveLength(0);
        });

        it.each([
            ['a body that is not JSON', 'ok'],
            ['a body that is not a connection', { status: 'ok', uptime: 42 }],
            ['no connection id', { connection_id: undefined }],
            ['an empty connection id', { connection_id: '' }],
            ['no project', { project: undefined }],
            ['no audience', { audience: undefined }],
            ['no issuer', { issuer: undefined }],
            ['an expiry that is not a number', { expires_at: 'tomorrow' }],
            ['no expiry', { expires_at: undefined }],
        ])('refuses a 200 with %s, with 503', async (_case, body) => {
            api.whoami({
                status: 200,
                body:
                    typeof body === 'string' || 'status' in body
                        ? body
                        : { ...api.issue('mat_x'), ...body },
            });

            const response = await callTool(server.url, 'ping');

            expect(response.status).toBe(503);
            expect(reasons(server, 'cannot check access tokens')).toEqual(['unexpected_answer']);
        });
    });

    describe('when the API refuses the service secret', () => {
        beforeEach(() => api.expectSecret('another-service-secret-of-thirty-two-chars'));

        it('answers 503 and never asks the client to authenticate again', async () => {
            const response = await callTool(server.url, 'ping');

            expect(response.status).toBe(503);
            expect(response.headers.get('www-authenticate')).toBeNull();
            expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
            expect(await response.json()).toEqual({
                error: 'temporarily_unavailable',
                error_description: expect.stringContaining('cannot check access tokens'),
            });
            expect(api.callsTo('/health')).toHaveLength(0);
        });

        it('says so loudly in its logs, and nothing of it in the response', async () => {
            const response = await callTool(server.url, 'ping');
            const text = await response.text();

            expect(server.logs).toContainEqual(
                expect.objectContaining({
                    level: 'error',
                    message: 'cannot check access tokens',
                    reason: 'service_credentials_refused',
                }),
            );
            expect(text).not.toMatch(/service|secret|credential/i);
        });

        it('answers the same for a token nobody was issued: the token is not looked at', async () => {
            const response = await callTool(server.url, 'ping', {}, bearer('mat_made-up'));
            expect(response.status).toBe(503);
        });

        it('does not remember the token as refused', async () => {
            await callTool(server.url, 'ping');
            api.expectSecret(SERVICE_SECRET);
            expect((await callTool(server.url, 'ping')).status).toBe(200);
        });
    });

    describe('when the API is down, slow or odd', () => {
        it('answers 503 with Retry-After when nothing listens, never 200 nor 401', async () => {
            const down = await startServer({ MESUB_API_URL: await deadUrl() });

            const response = await callTool(down.url, 'search_docs', { query: 'hasAccess' });

            expect(response.status).toBe(503);
            expect(response.headers.get('www-authenticate')).toBeNull();
            expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
            expect(await response.text()).not.toContain('docs.mesub.io');
            expect(reasons(down, 'cannot check access tokens')).toEqual(['api_unavailable']);
            await down.stop();
        });

        it('gives up on a slow API after its timeout, with 503', async () => {
            const slow = await startServer({ MESUB_API_URL: api.url }, { verifyTimeoutMs: 50 });
            const release = api.holdWhoami();

            const started = Date.now();
            const response = await callTool(slow.url, 'ping');

            expect(response.status).toBe(503);
            expect(Date.now() - started).toBeLessThan(2000);
            expect(api.callsTo('/health')).toHaveLength(0);
            release();
            await slow.stop();
        });

        it.each([
            [503, { 'Retry-After': '7' }, 503, '7'],
            [503, {}, 503, '5'],
            [503, { 'Retry-After': '86400' }, 503, '60'],
            [500, {}, 503, '5'],
            [502, {}, 503, '5'],
            [404, {}, 503, '5'],
            [403, {}, 503, '5'],
            [429, { 'Retry-After': '12' }, 429, '12'],
            [429, {}, 429, '10'],
        ])(
            'answers an API %i (%o) with %i and Retry-After %s',
            async (status, headers, expected, retryAfter) => {
                api.whoami({ status, body: { statusCode: status, message: 'no' }, headers });

                const response = await callTool(server.url, 'ping');

                expect(response.status).toBe(expected);
                expect(response.headers.get('retry-after')).toBe(retryAfter);
                expect(response.headers.get('www-authenticate')).toBeNull();
                expect(api.callsTo('/health')).toHaveLength(0);
            },
        );

        it.each([
            ['no code', { statusCode: 401, message: 'Unauthorized' }],
            ['a code it does not know', { statusCode: 401, code: 'unauthorized' }],
            ['a page from a proxy', '<html>401</html>'],
        ])('does not take a 401 with %s for a bad token', async (_case, body) => {
            api.whoami({ status: 401, body });

            const response = await callTool(server.url, 'ping');

            expect(response.status).toBe(503);
            expect(response.headers.get('www-authenticate')).toBeNull();
        });

        it('does not follow a redirect with the credentials', async () => {
            const elsewhere = await fakeMesubApi();
            api.whoami({
                status: 307,
                body: '',
                headers: { Location: `${elsewhere.url}/agent/whoami` },
            });

            const response = await callTool(server.url, 'ping');

            expect(response.status).toBe(503);
            expect(elsewhere.calls).toHaveLength(0);
            await elsewhere.close();
        });
    });

    describe('what a tool is handed', () => {
        it('gets the connection, the project and the client, and no credential', async () => {
            let seen: ToolContext | undefined;
            const probe = defineTool({
                name: 'probe',
                title: 'Probe',
                description: 'Records the context it was handed.',
                inputSchema: z.strictObject({}),
                outputSchema: z.object({ ok: z.boolean() }),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
                handler: async (_args, context) => {
                    seen = context;
                    return { data: { ok: true }, text: 'ok' };
                },
            });
            const probing = await startServer({ MESUB_API_URL: api.url }, { tools: [probe] });
            const issued = api.issue('mat_probe', {
                connection_id: 'conn_probe',
                project: { id: 'proj_42', name: 'Fraise' },
                client: { id: 'mcp_abc', name: 'An agent' },
            });

            const response = await callTool(probing.url, 'probe', {}, bearer('mat_probe'));
            expect(await readJsonRpc(response)).toMatchObject({
                result: { structuredContent: { ok: true } },
            });

            expect(seen?.caller).toEqual({
                connectionId: 'conn_probe',
                projectId: 'proj_42',
                projectName: 'Fraise',
                clientName: 'An agent',
                expiresAt: new Date(issued.expires_at * 1000),
            });
            expect(Object.keys(seen ?? {}).sort()).toEqual(['caller', 'mesub', 'signal']);
            // Printed, serialised or inspected, the context gives no credential away.
            const { inspect } = await import('node:util');
            const shown = `${JSON.stringify(seen)}${inspect(seen, { depth: 8, showHidden: true })}`;
            expect(shown).not.toContain('mat_probe');
            expect(shown).not.toContain(SERVICE_SECRET);
            await probing.stop();
        });
    });

    describe('the refused tokens it remembers', () => {
        let now: number;
        let timed: TestServer;
        beforeEach(async () => {
            // Frozen at the present: the fake API dates a token's expiry by the real clock.
            now = Date.now();
            timed = await startServer({ MESUB_API_URL: api.url }, { now: () => now });
        });
        afterEach(() => timed.stop());

        it('does not ask the API again for a token it just refused', async () => {
            for (let i = 0; i < 5; i++) {
                const response = await callTool(timed.url, 'ping', {}, bearer('mat_made-up'));
                expect(response.status).toBe(401);
                expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
            }

            expect(api.callsTo(WHOAMI)).toHaveLength(1);
            expect(reasons(timed, 'request refused')).toEqual([
                'refused_token',
                ...Array<string>(4).fill('refused_token_cached'),
            ]);
        });

        it('asks again once its short memory has run out, and not a millisecond before', async () => {
            await callTool(timed.url, 'ping', {}, bearer('mat_made-up'));

            now += REFUSED_TOKEN_TTL_MS - 1;
            await callTool(timed.url, 'ping', {}, bearer('mat_made-up'));
            expect(api.callsTo(WHOAMI)).toHaveLength(1);

            now += 1;
            await callTool(timed.url, 'ping', {}, bearer('mat_made-up'));
            expect(api.callsTo(WHOAMI)).toHaveLength(2);
        });

        it('never remembers a token as valid: only a refusal is kept', async () => {
            await callTool(timed.url, 'ping');
            api.revoke(TOKEN);
            expect((await callTool(timed.url, 'ping')).status).toBe(401);
        });

        it('keeps a revoked token out although the API would take it again', async () => {
            // The other way round cannot open anything: a remembered refusal only refuses.
            api.issue('mat_back');
            api.revoke('mat_back');
            await callTool(timed.url, 'ping', {}, bearer('mat_back'));
            api.issue('mat_back');

            expect((await callTool(timed.url, 'ping', {}, bearer('mat_back'))).status).toBe(401);
            now += REFUSED_TOKEN_TTL_MS;
            expect((await callTool(timed.url, 'ping', {}, bearer('mat_back'))).status).toBe(200);
        });
    });

    describe('secrets', () => {
        it('puts neither credential in any response or log line, whatever happens', async () => {
            const responses: string[] = [];
            const record = async (response: Response) => {
                responses.push(
                    JSON.stringify([...response.headers.entries()]),
                    await response.text(),
                );
            };

            await record(await callTool(server.url, 'ping'));
            await record(await post(server.url, '{not json', bearer()));
            await record(await callTool(server.url, 'nope'));
            api.answer(500, `Error: boom ${TOKEN} ${SERVICE_SECRET}`);
            await record(await callTool(server.url, 'ping'));
            api.answer(400, {
                statusCode: 400,
                message: `bad header: ${SERVICE_SECRET}, Bearer ${TOKEN}`,
                code: 'invalid_request',
            });
            await record(await callTool(server.url, 'ping'));
            api.whoami({
                status: 500,
                body: { message: `Authorization: Bearer ${TOKEN} / ${SERVICE_SECRET}` },
            });
            await record(await callTool(server.url, 'ping'));
            api.whoami({
                status: 401,
                body: { code: 'invalid_agent_token', message: `${TOKEN} ${SERVICE_SECRET}` },
            });
            await record(await callTool(server.url, 'ping'));
            api.whoami();
            api.expectSecret('another-service-secret-of-thirty-two-chars');
            await record(await callTool(server.url, 'ping'));
            api.revoke(TOKEN);
            api.expectSecret(SERVICE_SECRET);
            await record(await callTool(server.url, 'ping'));
            await record(await fetch(`${server.url}/.well-known/oauth-protected-resource`));
            await record(await fetch(`${server.url}/health`));

            const everything = `${responses.join('\n')}\n${server.lines.join('\n')}`;
            expect(server.lines.length).toBeGreaterThan(5);
            expect(everything).not.toContain(TOKEN);
            expect(everything).not.toContain(SERVICE_SECRET);
            expect(everything.toLowerCase()).not.toContain('x-mesub-service-secret');
            expect(server.lines.join('\n')).not.toMatch(/authorization"?:\s*"?bearer (?!\[)/i);
        });
    });
});
