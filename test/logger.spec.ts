import { createLogger, redact } from '../src/logger.js';
import { Secret } from '../src/secret.js';
import { memoryLogger } from './helpers.js';

describe('redact', () => {
    it('replaces the authorization header, whatever its casing and depth', () => {
        const safe = redact({
            headers: { Authorization: 'Bearer abc.def', 'content-type': 'application/json' },
            request: { headers: { authorization: 'Bearer abc.def' } },
        });

        expect(safe).toEqual({
            headers: { Authorization: '[redacted]', 'content-type': 'application/json' },
            request: { headers: { authorization: '[redacted]' } },
        });
    });

    it('replaces every credential-named field', () => {
        const safe = redact({
            cookie: 'a=b',
            'set-cookie': ['a=b'],
            token: 't',
            accessToken: 't',
            refresh_token: 't',
            secret: 's',
            webhookSecret: 's',
            password: 'p',
            apiKey: 'k',
            'x-api-key': 'k',
            signature: 'sig',
            plan: 'pro',
        });

        expect(safe).toEqual({
            cookie: '[redacted]',
            'set-cookie': '[redacted]',
            token: '[redacted]',
            accessToken: '[redacted]',
            refresh_token: '[redacted]',
            secret: '[redacted]',
            webhookSecret: '[redacted]',
            password: '[redacted]',
            apiKey: '[redacted]',
            'x-api-key': '[redacted]',
            signature: '[redacted]',
            plan: 'pro',
        });
    });

    it('replaces a bearer token quoted inside a string or an error', () => {
        expect(redact('sent Authorization: Bearer abc.def-123 to the API')).toBe(
            'sent Authorization: Bearer [redacted] to the API',
        );

        const error = new Error('refused: bearer abc.def-123');
        expect(JSON.stringify(redact({ error }))).not.toContain('abc.def-123');
    });

    it('reads a Headers object as its entries', () => {
        const headers = new Headers({ Authorization: 'Bearer abc', Accept: 'application/json' });
        expect(redact(headers)).toEqual({
            authorization: '[redacted]',
            accept: 'application/json',
        });
    });

    it('stops at a depth, so a cycle cannot hang a log line', () => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        expect(JSON.stringify(redact(loop))).toContain('[truncated]');
    });
});

describe('createLogger', () => {
    it('never writes the authorization header nor a bearer token', () => {
        const { logger, lines, logs } = memoryLogger();

        logger.info('got Bearer abc.def-123', {
            headers: { authorization: 'Bearer abc.def-123', cookie: 'session=abc.def-123' },
            error: new Error('Bearer abc.def-123 refused'),
        });

        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain('abc.def-123');
        expect(logs[0]).toMatchObject({
            level: 'info',
            message: 'got Bearer [redacted]',
            headers: { authorization: '[redacted]', cookie: '[redacted]' },
        });
    });

    it('writes nothing under its level', () => {
        const lines: string[] = [];
        const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });

        logger.debug('a');
        logger.info('b');
        logger.warn('c');
        logger.error('d');

        expect(lines.map((line) => (JSON.parse(line) as { message: string }).message)).toEqual([
            'c',
            'd',
        ]);
    });

    it('writes nothing at all when silent', () => {
        const lines: string[] = [];
        createLogger({ level: 'silent', write: (line) => lines.push(line) }).error('a');
        expect(lines).toEqual([]);
    });
});

describe('what this server holds that must never be written', () => {
    const SERVICE_SECRET = 'a-service-secret-of-thirty-two-chars!';
    const AGENT_TOKEN = 'mat_3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    it('replaces the service secret header, whatever its casing', () => {
        expect(
            redact({
                'X-Mesub-Service-Secret': SERVICE_SECRET,
                headers: { 'x-mesub-service-secret': SERVICE_SECRET },
                serviceSecret: SERVICE_SECRET,
            }),
        ).toEqual({
            'X-Mesub-Service-Secret': '[redacted]',
            headers: { 'x-mesub-service-secret': '[redacted]' },
            serviceSecret: '[redacted]',
        });
    });

    it('replaces a Secret wherever it sits, under any name', () => {
        const secret = new Secret(SERVICE_SECRET);
        const safe = JSON.stringify(redact({ value: secret, list: [secret], deep: { a: secret } }));

        expect(safe).not.toContain(SERVICE_SECRET);
        expect(JSON.parse(safe)).toEqual({
            value: '[redacted]',
            list: ['[redacted]'],
            deep: { a: '[redacted]' },
        });
    });

    it('replaces anything shaped like a Mesub token inside a string, without "Bearer"', () => {
        for (const prefix of ['mat_', 'mrt_', 'mac_']) {
            const value = `${prefix}3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
            expect(redact(`refused ${value}, again (${value})`)).toBe(
                'refused [redacted], again ([redacted])',
            );
        }
        expect(redact({ note: `x=${AGENT_TOKEN}` })).toEqual({ note: 'x=[redacted]' });
        expect(redact('format_string and a mat_')).toBe('format_string and a mat_');
    });

    it('scrubs the literal secrets it was given from every line, wherever they hide', () => {
        const lines: string[] = [];
        const logger = createLogger({
            level: 'debug',
            write: (line) => lines.push(line),
            secrets: [new Secret(SERVICE_SECRET)],
        });

        logger.error(`boom ${SERVICE_SECRET}`, {
            url: `http://api/agent/whoami?x=${SERVICE_SECRET}`,
            error: new Error(`fetch failed with ${SERVICE_SECRET} and ${AGENT_TOKEN}`),
            list: [SERVICE_SECRET],
            [SERVICE_SECRET]: 'as a key',
        });

        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(SERVICE_SECRET);
        expect(lines[0]).not.toContain(AGENT_TOKEN);
        expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'error' });
    });
});
