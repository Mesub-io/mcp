import { API_VERSION, MesubClient } from '../src/mesub/client.js';
import { MesubApiError } from '../src/mesub/errors.js';
import { VERSION } from '../src/version.js';
import { deadUrl, fakeMesubApi, TOKEN, type FakeApi } from './helpers.js';

describe('MesubClient', () => {
    let api: FakeApi;
    beforeEach(async () => {
        api = await fakeMesubApi();
    });
    afterEach(() => api.close());

    const client = (options: { baseUrl?: string; timeoutMs?: number } = {}) =>
        new MesubClient({ baseUrl: api.url, token: TOKEN, ...options });

    const failureOf = async (call: Promise<unknown>): Promise<MesubApiError> => {
        const error = await call.then(
            () => undefined,
            (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(MesubApiError);
        return error as MesubApiError;
    };

    it('sends the token, the API version and JSON headers', async () => {
        await expect(client().health()).resolves.toEqual({ status: 'ok', uptime: 42 });

        expect(api.calls).toHaveLength(1);
        expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/health' });
        expect(api.calls[0]?.headers).toMatchObject({
            authorization: `Bearer ${TOKEN}`,
            accept: 'application/json',
            'mesub-version': API_VERSION,
            'user-agent': `@mesub/mcp/${VERSION}`,
        });
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
            fetch: never,
            timeoutMs: 20,
        });

        const error = await failureOf(slow.health());
        expect(error).toMatchObject({ status: null, code: 'unavailable', retryable: true });
        expect(error.message).toBe('Mesub did not answer within 20 ms.');
    });

    it('does not follow a redirect with the token', async () => {
        api.answer(302, '', { Location: 'http://127.0.0.1:1/elsewhere' });

        const error = await failureOf(client().health());
        expect(error).toMatchObject({ status: null, code: 'unavailable' });
        expect(api.calls).toHaveLength(1);
    });
});
