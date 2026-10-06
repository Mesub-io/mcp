import { inspect } from 'node:util';

import { API_VERSION, apiUrl, MesubClient, pathSegment } from '../src/mesub/client.js';
import { MesubApiError } from '../src/mesub/errors.js';
import { Secret } from '../src/secret.js';
import { VERSION } from '../src/version.js';
import { deadUrl, fakeMesubApi, RESOURCE, SERVICE_SECRET, TOKEN, type FakeApi } from './helpers.js';

describe('MesubClient', () => {
    let api: FakeApi;
    beforeEach(async () => {
        api = await fakeMesubApi();
    });
    afterEach(() => api.close());

    const client = (options: { baseUrl?: string; timeoutMs?: number } = {}) =>
        new MesubClient({
            baseUrl: api.url,
            token: TOKEN,
            serviceSecret: new Secret(SERVICE_SECRET),
            ...options,
        });

    const failureOf = async (call: Promise<unknown>): Promise<MesubApiError> => {
        const error = await call.then(
            () => undefined,
            (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(MesubApiError);
        return error as MesubApiError;
    };

    it('sends the API version and JSON headers, and no credential to the public /health', async () => {
        await expect(client().health()).resolves.toEqual({ status: 'ok', uptime: 42 });

        expect(api.calls).toHaveLength(1);
        expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/health' });
        expect(api.calls[0]?.headers).toMatchObject({
            accept: 'application/json',
            'mesub-version': API_VERSION,
            'user-agent': `@mesub/mcp/${VERSION}`,
        });
        expect(api.calls[0]?.headers.authorization).toBeUndefined();
        expect(api.calls[0]?.headers['x-mesub-service-secret']).toBeUndefined();
        expect(JSON.stringify(api.calls[0])).not.toContain(TOKEN);
        expect(JSON.stringify(api.calls[0])).not.toContain(SERVICE_SECRET);
    });

    it("sends the agent's token and the service secret together to /agent/whoami", async () => {
        await expect(client().whoami()).resolves.toMatchObject({
            connection_id: 'conn_1',
            project: { id: 'proj_1', name: 'Fraise' },
            client: { name: 'Test agent' },
            audience: RESOURCE,
            issuer: api.url,
        });

        expect(api.calls).toHaveLength(1);
        expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/agent/whoami' });
        expect(api.calls[0]?.headers).toMatchObject({
            authorization: `Bearer ${TOKEN}`,
            'x-mesub-service-secret': SERVICE_SECRET,
            'mesub-version': API_VERSION,
        });
    });

    it("reports the API's two refusals of a check by their code", async () => {
        await expect(
            failureOf(
                new MesubClient({
                    baseUrl: api.url,
                    token: 'mat_unknown',
                    serviceSecret: new Secret(SERVICE_SECRET),
                }).whoami(),
            ),
        ).resolves.toMatchObject({ status: 401, code: 'invalid_agent_token' });

        await expect(
            failureOf(
                new MesubClient({
                    baseUrl: api.url,
                    token: TOKEN,
                    serviceSecret: new Secret('another-service-secret-of-thirty-two-chars'),
                }).whoami(),
            ),
        ).resolves.toMatchObject({ status: 401, code: 'invalid_service_credentials' });
    });

    it('gives nothing of either credential away when printed, serialised or inspected', () => {
        const shown = [
            JSON.stringify(client()),
            inspect(client(), { depth: 10, showHidden: true }),
            String(client()),
            JSON.stringify(Object.entries(client())),
        ].join('\n');

        expect(shown).not.toContain(TOKEN);
        expect(shown).not.toContain(SERVICE_SECRET);
    });

    it('scrubs a credential the API would quote back in an error', async () => {
        api.answer(400, {
            statusCode: 400,
            message: `Bad header: ${SERVICE_SECRET}, bearer ${TOKEN}`,
            code: 'invalid_request',
        });

        const error = await failureOf(client().health());
        expect(error.message).toBe('Bad header: [redacted], bearer [redacted]');
        expect(inspect(error, { depth: 10 })).not.toContain(SERVICE_SECRET);
    });

    it('never puts a cause that may quote a header or the URL in what it throws', async () => {
        const leaking: typeof fetch = () =>
            Promise.reject(new TypeError(`fetch failed: Bearer ${TOKEN} / ${SERVICE_SECRET}`));
        const error = await failureOf(
            new MesubClient({
                baseUrl: api.url,
                token: TOKEN,
                serviceSecret: new Secret(SERVICE_SECRET),
                fetch: leaking,
            }).whoami(),
        );

        const shown = `${inspect(error, { depth: 10, showHidden: true })}${JSON.stringify(error)}${error.stack}`;
        expect(error.message).toBe('Could not reach the Mesub API.');
        expect(shown).not.toContain(TOKEN);
        expect(shown).not.toContain(SERVICE_SECRET);
    });

    it('keeps a path the base URL carries', async () => {
        await client({ baseUrl: `${api.url}/api` }).health();
        expect(api.calls[0]?.path).toBe('/api/health');
    });

    it('drops the fields its schema does not name', async () => {
        api.answer(200, { status: 'ok', uptime: 1, internal: 'x' });
        await expect(client().health()).resolves.toEqual({ status: 'ok', uptime: 1 });
    });

    it("maps a Mesub error body to its code, message and 'retryable'", async () => {
        api.answer(
            503,
            {
                statusCode: 503,
                message: 'Not answering: postgres',
                code: 'unavailable',
                retryable: true,
            },
            { 'Retry-After': '10' },
        );

        const error = await failureOf(client().health());
        expect(error).toMatchObject({
            status: 503,
            code: 'unavailable',
            message: 'Not answering: postgres',
            retryable: true,
            retryAfterSeconds: 10,
        });
    });

    it('joins a list of validation messages', async () => {
        api.answer(400, {
            statusCode: 400,
            message: ['limit must be a number', 'cursor must be a string'],
            code: 'invalid_request',
            retryable: false,
        });

        const error = await failureOf(client().health());
        expect(error.message).toBe('limit must be a number; cursor must be a string');
        expect(error).toMatchObject({ code: 'invalid_request', retryable: false });
    });

    it.each([
        [401, 'unauthorized', false],
        [403, 'forbidden', false],
        [404, 'not_found', false],
        [409, 'conflict', false],
        [429, 'rate_limited', true],
        [500, 'internal_error', true],
        [502, 'internal_error', true],
        [503, 'unavailable', true],
        [418, 'unexpected', false],
    ])(
        'falls back on the status for a %i that is not a Mesub error',
        async (status, code, retryable) => {
            api.answer(status, '<html>proxy</html>');

            const error = await failureOf(client().health());
            expect(error).toMatchObject({
                status,
                code,
                retryable,
                message: `Mesub answered with HTTP ${status}.`,
            });
        },
    );

    it('refuses a 2xx it cannot read', async () => {
        api.answer(200, { status: 'ok' });
        await expect(failureOf(client().health())).resolves.toMatchObject({
            status: 200,
            code: 'unexpected',
            retryable: false,
        });

        api.answer(200, 'not json');
        await expect(failureOf(client().health())).resolves.toMatchObject({ code: 'unexpected' });
    });

    it('reports an API nothing answers at as unavailable, without the URL', async () => {
        const baseUrl = await deadUrl();

        const error = await failureOf(client({ baseUrl }).health());
        expect(error).toMatchObject({ status: null, code: 'unavailable', retryable: true });
        expect(error.message).toBe('Could not reach the Mesub API.');
    });

    it('gives up after its timeout', async () => {
        const never: typeof fetch = (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            });
        const slow = new MesubClient({
            baseUrl: api.url,
            token: TOKEN,
            serviceSecret: new Secret(SERVICE_SECRET),
            fetch: never,
            timeoutMs: 20,
        });

        const error = await failureOf(slow.health());
        expect(error).toMatchObject({ status: null, code: 'unavailable', retryable: true });
        expect(error.message).toBe('Mesub did not answer within 20 ms.');
    });

    it('gives up on a check after the time it was given for it', async () => {
        const release = api.holdWhoami();

        const error = await failureOf(client().whoami({ timeoutMs: 30 }));
        expect(error).toMatchObject({ status: null, code: 'unavailable', retryable: true });
        release();
    });

    it('does not follow a redirect, with or without credentials', async () => {
        const elsewhere = await fakeMesubApi();
        api.answer(302, '', { Location: `${elsewhere.url}/health` });
        api.whoami({
            status: 307,
            body: '',
            headers: { Location: `${elsewhere.url}/agent/whoami` },
        });

        for (const call of [client().health(), client().whoami()]) {
            const error = await failureOf(call);
            expect(error).toMatchObject({ status: null, code: 'unavailable' });
        }
        expect(api.calls).toHaveLength(2);
        expect(elsewhere.calls).toHaveLength(0);
        await elsewhere.close();
    });
});

describe('apiUrl', () => {
    const base = 'https://api.mesub.io/v1';

    it('joins the base, a path and a query, encoded', () => {
        expect(apiUrl(base, '/plans').href).toBe('https://api.mesub.io/v1/plans');
        expect(
            apiUrl(base, '/plans', {
                limit: 10,
                cursor: 'a b&c=d',
                archived: false,
                none: undefined,
            }).href,
        ).toBe('https://api.mesub.io/v1/plans?limit=10&cursor=a+b%26c%3Dd&archived=false');
    });

    it.each([
        ['no leading slash', 'plans'],
        ['a way up', '/plans/../../admin'],
        ['an encoded way up', '/plans/%2e%2e/admin'],
        ['a single dot segment', '/plans/./x'],
        ['another host', '//evil.example.com/x'],
        ['an empty segment', '/plans//x'],
        ['a query of its own', '/plans?as=other'],
        ['a fragment', '/plans#x'],
        ['a backslash', '/plans\\..\\x'],
        ['credentials', '/@evil.example.com'],
        ['a line break', '/plans\r\nX-Injected: 1'],
        ['a space', '/plans /x'],
    ])('refuses a path with %s, without quoting it', (_case, path) => {
        expect(() => apiUrl(base, path)).toThrow('Refused to call a path that is not a plain one.');
    });

    it('stays under the base whatever an id says, once it went through pathSegment', () => {
        for (const id of ['../../admin', 'a/b', 'a?b=c', 'a#b', '%2e%2e', 'é', 'a b', '@evil']) {
            const url = apiUrl(base, `/plans/${pathSegment(id)}`);
            expect(url.origin).toBe('https://api.mesub.io');
            expect(url.pathname.startsWith('/v1/plans/')).toBe(true);
            expect(url.pathname.split('/')).toHaveLength(4);
            expect(url.search).toBe('');
            expect(url.hash).toBe('');
        }
    });

    it.each(['', '.', '..'])('refuses %j as a path segment', (id) => {
        expect(() => pathSegment(id)).toThrow('Refused a path segment that is not a plain one.');
    });
});
