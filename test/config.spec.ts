import { inspect } from 'node:util';

import { ConfigError, loadConfig } from '../src/config.js';
import { Secret } from '../src/secret.js';

const SECRET = 'a-service-secret-of-thirty-two-chars!';
/** The least an environment must hold. */
const required = { MESUB_SERVICE_SECRET: SECRET, MESUB_ISSUER_URL: 'https://api.mesub.io' };

describe('loadConfig', () => {
    it('has a default for everything but the service secret and the issuer', () => {
        const config = loadConfig(required);

        expect(config).toEqual({
            mesubApiUrl: 'https://api.mesub.io',
            issuerUrl: 'https://api.mesub.io',
            serviceSecret: expect.any(Secret),
            port: 3000,
            host: '127.0.0.1',
            publicUrl: 'http://localhost:3000',
            resourceUrl: 'http://localhost:3000/mcp',
            allowedOrigins: [],
            clientIpHeader: undefined,
            logLevel: 'info',
        });
        expect(config.serviceSecret.reveal()).toBe(SECRET);
    });

    it('reads every variable', () => {
        const config = loadConfig({
            MESUB_API_URL: 'http://localhost:3333/',
            MESUB_ISSUER_URL: 'http://localhost:3333/',
            MESUB_SERVICE_SECRET: ` ${SECRET} `,
            PORT: '8080',
            HOST: '0.0.0.0',
            MCP_PUBLIC_URL: 'https://mcp.example.com/',
            MCP_ALLOWED_ORIGINS: 'app.example.com, Other.Example.com ,',
            CLIENT_IP_HEADER: 'fly-client-ip',
            LOG_LEVEL: 'debug',
        });

        expect(config).toEqual({
            mesubApiUrl: 'http://localhost:3333',
            issuerUrl: 'http://localhost:3333',
            serviceSecret: expect.any(Secret),
            port: 8080,
            host: '0.0.0.0',
            publicUrl: 'https://mcp.example.com',
            resourceUrl: 'https://mcp.example.com/mcp',
            allowedOrigins: ['app.example.com', 'other.example.com'],
            clientIpHeader: 'fly-client-ip',
            logLevel: 'debug',
        });
        expect(config.serviceSecret.reveal()).toBe(SECRET);
    });

    it('takes a variable set to nothing as not set', () => {
        expect(loadConfig({ ...required, PORT: '', MESUB_API_URL: '  ' }).port).toBe(3000);
    });

    it('derives the public URL, and the resource a token is issued for, from the port', () => {
        const config = loadConfig({ ...required, PORT: '4100' });
        expect(config.publicUrl).toBe('http://localhost:4100');
        expect(config.resourceUrl).toBe('http://localhost:4100/mcp');
    });

    it.each([
        ['https://MCP.Example.com', 'https://mcp.example.com/mcp'],
        ['https://mcp.example.com:443/', 'https://mcp.example.com/mcp'],
        ['https://mcp.example.com/agents/', 'https://mcp.example.com/agents/mcp'],
        ['http://localhost:3334', 'http://localhost:3334/mcp'],
    ])('writes the resource of %s as the API compares it: %s', (publicUrl, resourceUrl) => {
        expect(loadConfig({ ...required, MCP_PUBLIC_URL: publicUrl }).resourceUrl).toBe(
            resourceUrl,
        );
    });

    it.each([
        ['MESUB_API_URL', 'api.mesub.io'],
        ['MESUB_API_URL', 'ftp://api.mesub.io'],
        ['MESUB_API_URL', 'https://user:pass@api.mesub.io'],
        ['MESUB_API_URL', 'https://api.mesub.io?key=1'],
        ['MCP_PUBLIC_URL', 'not a url'],
        ['PORT', 'http'],
        ['PORT', '70000'],
        ['PORT', '80.5'],
        ['LOG_LEVEL', 'verbose'],
        ['MCP_ALLOWED_ORIGINS', 'https://app.example.com'],
        ['MESUB_ISSUER_URL', 'api.mesub.io'],
        ['MESUB_ISSUER_URL', 'http://api.mesub.io'],
        ['MESUB_ISSUER_URL', 'https://api.mesub.io/v1'],
        ['MESUB_ISSUER_URL', 'https://api.mesub.io?x=1'],
        ['MESUB_ISSUER_URL', 'https://api.mesub.io#x'],
        ['MESUB_ISSUER_URL', 'https://user:pass@api.mesub.io'],
        ['CLIENT_IP_HEADER', 'x-forwarded-for'],
        ['CLIENT_IP_HEADER', 'X-Forwarded-For'],
        ['CLIENT_IP_HEADER', 'forwarded'],
        ['CLIENT_IP_HEADER', 'x-real-ip'],
        ['CLIENT_IP_HEADER', 'Fly-Client-IP'],
    ])('refuses %s=%s, naming the variable', (name, value) => {
        const attempt = () => loadConfig({ ...required, [name]: value });
        expect(attempt).toThrow(ConfigError);
        expect(attempt).toThrow(new RegExp(`^Invalid configuration:\\n  ${name}: `));
    });

    it('names every variable that is wrong, and no value', () => {
        const attempt = () =>
            loadConfig({ ...required, PORT: 'abc', MESUB_API_URL: 'https://u:hunter2@x.io' });
        expect(attempt).toThrow(/MESUB_API_URL: .*\n  PORT: /);
        expect(attempt).not.toThrow(/hunter2/);
    });

    it('reads no API key, whatever the environment holds', () => {
        const config = loadConfig({ ...required, MESUB_API_KEY: 'SUB_x', API_KEY: 'SUB_y' });
        expect(JSON.stringify(config)).not.toContain('SUB_');
    });

    describe('the service secret', () => {
        it.each([
            ['none', undefined],
            ['an empty one', ''],
            ['one of spaces', '   '],
            ['one of 31 characters', 'x'.repeat(31)],
            ['one with a space inside', `${'x'.repeat(20)} ${'y'.repeat(20)}`],
            ['one with a line break', `${'x'.repeat(20)}\r\nX-Injected: 1${'y'.repeat(20)}`],
            ['one that is not ASCII', `${'x'.repeat(40)}é`],
        ])('refuses to start with %s, rather than run open', (_case, value) => {
            const env = { ...required, MESUB_SERVICE_SECRET: value };
            expect(() => loadConfig(env)).toThrow(ConfigError);
            expect(() => loadConfig(env)).toThrow(/\n {2}MESUB_SERVICE_SECRET: /);
        });

        it('takes one of exactly 32 characters', () => {
            const config = loadConfig({ ...required, MESUB_SERVICE_SECRET: 'x'.repeat(32) });
            expect(config.serviceSecret.reveal()).toHaveLength(32);
        });

        it('never quotes it in a refusal', () => {
            const short = 'short-but-still-private';
            const attempt = () =>
                loadConfig({ ...required, MESUB_SERVICE_SECRET: short, PORT: 'abc' });
            expect(attempt).toThrow(/MESUB_SERVICE_SECRET/);
            expect(attempt).not.toThrow(new RegExp(short));
        });

        it('cannot be printed, serialised nor inspected out of the configuration', () => {
            const config = loadConfig(required);
            const shown = [
                JSON.stringify(config),
                inspect(config, { depth: 10, showHidden: true }),
                String(config.serviceSecret),
                `${config.serviceSecret}`,
                JSON.stringify({ ...config.serviceSecret }),
            ].join('\n');

            expect(shown).not.toContain(SECRET);
            expect(shown).toContain('[redacted]');
        });
    });

    describe('the issuer', () => {
        it('is required: nothing says the API is called where it is published', () => {
            const attempt = () => loadConfig({ MESUB_SERVICE_SECRET: SECRET });
            expect(attempt).toThrow(/\n {2}MESUB_ISSUER_URL: /);
        });

        it.each(['http://localhost:3333', 'http://127.0.0.1:3333', 'http://[::1]:3333'])(
            'may be plain http on this machine: %s',
            (issuer) => {
                expect(loadConfig({ ...required, MESUB_ISSUER_URL: issuer }).issuerUrl).toBe(
                    issuer,
                );
            },
        );

        it('is kept as written, as the API writes it in its own metadata', () => {
            const config = loadConfig({ ...required, MESUB_ISSUER_URL: 'https://API.Mesub.io/' });
            expect(config.issuerUrl).toBe('https://API.Mesub.io');
        });
    });
});
