import { inspect } from 'node:util';

import { ConfigError, loadConfig, takeConfig } from '../src/config.js';
import { revealSecret, Secret } from '../src/secret.js';

const SECRET = 'a-service-secret-of-thirty-two-chars!';
/** The least an environment must hold. */
const required = { MESUB_SERVICE_SECRET: SECRET, MESUB_ISSUER_URL: 'https://api.mesub.io' };
/** And once the server is not on this machine. */
const hosted = { ...required, CLIENT_IP_HEADER: 'none' };

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
            clientAddress: { header: undefined, trustedProxies: undefined },
            logLevel: 'info',
        });
        expect(revealSecret(config.serviceSecret)).toBe(SECRET);
    });

    it('reads every variable', () => {
        const config = loadConfig({
            MESUB_API_URL: 'http://localhost:3333/',
            MESUB_ISSUER_URL: 'http://localhost:3333/',
            MESUB_SERVICE_SECRET: ` ${SECRET} `,
            PORT: '8080',
            HOST: '0.0.0.0',
            MCP_PUBLIC_URL: 'https://mcp.example.com/',
            MCP_ALLOWED_ORIGINS: 'https://app.example.com, HTTPS://Other.Example.com:8443/ ,',
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
            allowedOrigins: ['https://app.example.com', 'https://other.example.com:8443'],
            clientAddress: { header: 'fly-client-ip', trustedProxies: undefined },
            logLevel: 'debug',
        });
        expect(revealSecret(config.serviceSecret)).toBe(SECRET);
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
        ['HTTPS://MCP.Mesub.IO:443', 'https://mcp.mesub.io/mcp'],
        ['http://localhost:3334', 'http://localhost:3334/mcp'],
    ])('writes the resource of %s as the API compares it: %s', (publicUrl, resourceUrl) => {
        const config = loadConfig({ ...hosted, MCP_PUBLIC_URL: publicUrl });
        expect(config.resourceUrl).toBe(resourceUrl);
        expect(config.publicUrl).toBe(resourceUrl.slice(0, -'/mcp'.length));
    });

    it.each([
        'https://mcp.mesub.io/mcp',
        'https://mcp.mesub.io/mcp/',
        'https://mesub.io/agents/',
        'https://mesub.io/agents',
        'https://mcp.mesub.io//',
    ])('M4: refuses MCP_PUBLIC_URL=%s: the resource would not be <origin>/mcp', (publicUrl) => {
        const attempt = () => loadConfig({ ...hosted, MCP_PUBLIC_URL: publicUrl });
        expect(attempt).toThrow(/\n {2}MCP_PUBLIC_URL: must be an origin, without a path/);
    });

    describe('L5: plain http', () => {
        it.each(['http://10.0.0.5:3333', 'http://api.mesub.io', 'http://mesub-api.internal:3333'])(
            'refuses MESUB_API_URL=%s unless the network is said to be private',
            (url) => {
                expect(() => loadConfig({ ...required, MESUB_API_URL: url })).toThrow(
                    /\n {2}MESUB_API_URL: must be https.*MESUB_API_PRIVATE_NETWORK=true/,
                );
                expect(
                    loadConfig({
                        ...required,
                        MESUB_API_URL: url,
                        MESUB_API_PRIVATE_NETWORK: 'true',
                    }).mesubApiUrl,
                ).toBe(url);
            },
        );

        it.each(['http://localhost:3333', 'http://127.0.0.1:3333', 'http://[::1]:3333'])(
            'takes %s as it is: this machine',
            (url) => {
                expect(loadConfig({ ...required, MESUB_API_URL: url }).mesubApiUrl).toBe(url);
            },
        );

        it.each(['yes', '1', 'TRUE', 'false'])(
            'takes nothing but "true" for the opt-in: %s',
            (value) => {
                expect(() => loadConfig({ ...required, MESUB_API_PRIVATE_NETWORK: value })).toThrow(
                    /\n {2}MESUB_API_PRIVATE_NETWORK: /,
                );
            },
        );
    });

    describe('M3: the client address', () => {
        it('must be chosen once the server is not on this machine: nothing is assumed', () => {
            const attempt = () =>
                loadConfig({ ...required, MCP_PUBLIC_URL: 'https://mcp.example.com' });
            expect(attempt).toThrow(/\n {2}CLIENT_IP_HEADER: is required/);
            expect(attempt).toThrow(/none/);
        });

        it.each(['none', 'fly-client-ip', 'cf-connecting-ip'] as const)('may be %s', (header) => {
            const config = loadConfig({ ...hosted, CLIENT_IP_HEADER: header });
            expect(config.clientAddress.header).toBe(header === 'none' ? undefined : header);
        });

        it('is the socket peer on this machine, unasked', () => {
            expect(loadConfig(required).clientAddress.header).toBeUndefined();
        });

        it('reads the ranges of the edge in front of the platform proxy', () => {
            const config = loadConfig({
                ...hosted,
                CLIENT_IP_HEADER: 'cf-connecting-ip',
                TRUSTED_PROXY_CIDRS: '173.245.48.0/20, 2400:cb00::/32 ,',
            });
            expect(config.clientAddress.trustedProxies?.check('173.245.50.1', 'ipv4')).toBe(true);
            expect(config.clientAddress.trustedProxies?.check('2400:cb00::1', 'ipv6')).toBe(true);
            expect(config.clientAddress.trustedProxies?.check('203.0.113.1', 'ipv4')).toBe(false);
        });

        it.each([
            [
                'a range that is not one',
                { CLIENT_IP_HEADER: 'cf-connecting-ip', TRUSTED_PROXY_CIDRS: '10.0.0.0/33' },
            ],
            [
                'an address without its length',
                { CLIENT_IP_HEADER: 'cf-connecting-ip', TRUSTED_PROXY_CIDRS: '10.0.0.1' },
            ],
            [
                'ranges with a header they mean nothing for',
                { CLIENT_IP_HEADER: 'fly-client-ip', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' },
            ],
            [
                'ranges with no header',
                { CLIENT_IP_HEADER: 'none', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' },
            ],
        ])('refuses %s', (_case, env) => {
            expect(() => loadConfig({ ...hosted, ...env })).toThrow(/\n {2}TRUSTED_PROXY_CIDRS: /);
        });
    });

    describe('L2: the origins a browser may call from', () => {
        it.each([
            'app.example.com',
            'https://app.example.com/path',
            'https://app.example.com?x=1',
            'https://user@app.example.com',
            '*',
            'https://*.example.com',
            'chrome-extension:',
            'null',
        ])('refuses %s: an origin is a scheme, a host and a port', (origin) => {
            expect(() => loadConfig({ ...required, MCP_ALLOWED_ORIGINS: origin })).toThrow(
                /\n {2}MCP_ALLOWED_ORIGINS: /,
            );
        });
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
        ['MCP_PUBLIC_URL', 'https://mcp.example.com?x=1'],
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
        ['CLIENT_IP_HEADER', ''.padEnd(3, 'x')],
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
            ['one in quotes, as copied from a file', `"${'x'.repeat(40)}"`],
            ['one with a backslash', `${'x'.repeat(40)}\\n`],
        ])('refuses to start with %s, rather than run open', (_case, value) => {
            const env = { ...required, MESUB_SERVICE_SECRET: value };
            expect(() => loadConfig(env)).toThrow(ConfigError);
            expect(() => loadConfig(env)).toThrow(/\n {2}MESUB_SERVICE_SECRET: /);
        });

        it('takes one of exactly 32 characters', () => {
            const config = loadConfig({ ...required, MESUB_SERVICE_SECRET: 'x'.repeat(32) });
            expect(revealSecret(config.serviceSecret)).toHaveLength(32);
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

    it('L7: holds no way to read the service secret back but the one the API client imports', () => {
        const config = loadConfig(required);
        expect(
            Object.getOwnPropertyNames(Object.getPrototypeOf(config.serviceSecret)),
        ).not.toContain('reveal');
        expect('reveal' in config.serviceSecret).toBe(false);
    });

    it('L7: takes the service secret out of the environment as it reads it', () => {
        const env: Record<string, string | undefined> = { ...required, PORT: '4100' };
        const config = takeConfig(env);

        expect(revealSecret(config.serviceSecret)).toBe(SECRET);
        expect(env.MESUB_SERVICE_SECRET).toBeUndefined();
        expect('MESUB_SERVICE_SECRET' in env).toBe(false);
        expect(env.PORT).toBe('4100');

        // Also when the rest of the environment does not fit.
        const bad: Record<string, string | undefined> = { ...required, PORT: 'abc' };
        expect(() => takeConfig(bad)).toThrow(ConfigError);
        expect('MESUB_SERVICE_SECRET' in bad).toBe(false);
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
