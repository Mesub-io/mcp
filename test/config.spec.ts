import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
    it('has a default for everything', () => {
        expect(loadConfig({})).toEqual({
            mesubApiUrl: 'https://api.mesub.io',
            port: 3000,
            host: '127.0.0.1',
            publicUrl: 'http://localhost:3000',
            allowedOrigins: [],
            logLevel: 'info',
        });
    });

    it('reads every variable', () => {
        const config = loadConfig({
            MESUB_API_URL: 'http://localhost:3333/',
            PORT: '8080',
            HOST: '0.0.0.0',
            MCP_PUBLIC_URL: 'https://mcp.example.com/',
            MCP_ALLOWED_ORIGINS: 'app.example.com, Other.Example.com ,',
            LOG_LEVEL: 'debug',
        });

        expect(config).toEqual({
            mesubApiUrl: 'http://localhost:3333',
            port: 8080,
            host: '0.0.0.0',
            publicUrl: 'https://mcp.example.com',
            allowedOrigins: ['app.example.com', 'other.example.com'],
            logLevel: 'debug',
        });
    });

    it('takes a variable set to nothing as not set', () => {
        expect(loadConfig({ PORT: '', MESUB_API_URL: '  ' }).port).toBe(3000);
    });

    it('derives the public URL from the port', () => {
        expect(loadConfig({ PORT: '4100' }).publicUrl).toBe('http://localhost:4100');
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
    ])('refuses %s=%s, naming the variable', (name, value) => {
        expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
        expect(() => loadConfig({ [name]: value })).toThrow(
            new RegExp(`^Invalid configuration:\\n  ${name}: `),
        );
    });

    it('names every variable that is wrong, and no value', () => {
        const attempt = () => loadConfig({ PORT: 'abc', MESUB_API_URL: 'https://u:hunter2@x.io' });
        expect(attempt).toThrow(/MESUB_API_URL: .*\n  PORT: /);
        expect(attempt).not.toThrow(/hunter2/);
    });

    it('reads no API key, whatever the environment holds', () => {
        const config = loadConfig({ MESUB_API_KEY: 'SUB_x', API_KEY: 'SUB_y' });
        expect(JSON.stringify(config)).not.toContain('SUB_');
    });
});
