import * as z from 'zod';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
    /** The Mesub HTTP API every tool calls, without a trailing slash. */
    mesubApiUrl: string;
    port: number;
    /** The interface to listen on. Loopback unless told otherwise. */
    host: string;
    /** Where clients reach this server, without a trailing slash: `<publicUrl>/mcp`. */
    publicUrl: string;
    /** Hostnames a browser `Origin` may carry, besides the public URL's own. */
    allowedOrigins: string[];
    logLevel: LogLevel;
}

/** Thrown at start, with one line per variable that does not fit. */
export class ConfigError extends Error {
    override readonly name = 'ConfigError';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL points at this machine. */
export function isLoopback(url: string): boolean {
    return LOOPBACK.has(new URL(url).hostname);
}

/** An http(s) URL carrying no credentials, query nor fragment. */
function isBaseUrl(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const { protocol, search, hash, username, password } = new URL(value);
    return (
        (protocol === 'http:' || protocol === 'https:') &&
        search === '' &&
        hash === '' &&
        username === '' &&
        password === ''
    );
}

// Stored without its trailing slash.
const baseUrl = z
    .string()
    .refine(isBaseUrl, 'must be an http or https URL, without credentials, query nor fragment')
    .transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
    MESUB_API_URL: baseUrl.default('https://api.mesub.io'),
    PORT: z.coerce
        .number({ error: 'must be a port number' })
        .int('must be a port number')
        .min(0, 'must be a port number')
        .max(65535, 'must be a port number')
        .default(3000),
    HOST: z.string().default('127.0.0.1'),
    MCP_PUBLIC_URL: baseUrl.optional(),
    MCP_ALLOWED_ORIGINS: z
        .string()
        .default('')
        .transform((value) =>
            value
                .split(',')
                .map((item) => item.trim().toLowerCase())
                .filter((item) => item !== ''),
        )
        .refine(
            (items) => items.every((item) => !item.includes('/')),
            'must be hostnames separated by commas, without scheme nor port',
        ),
    LOG_LEVEL: z
        .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
        .default('info'),
});

/**
 * The whole configuration, read once from the environment. No API key is read
 * here nor anywhere else: the caller's own token is the only credential.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
    // A variable set to nothing is a variable not set.
    const set = Object.fromEntries(
        Object.keys(schema.shape)
            .map((name) => [name, env[name]?.trim()] as const)
            .filter(([, value]) => value !== undefined && value !== ''),
    );

    const parsed = schema.safeParse(set);
    if (!parsed.success) {
        // The names and what is wrong, never the values.
        const lines = parsed.error.issues.map(
            (issue) => `  ${String(issue.path[0])}: ${issue.message}`,
        );
        throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
    }

    const { data } = parsed;
    return {
        mesubApiUrl: data.MESUB_API_URL,
        port: data.PORT,
        host: data.HOST,
        publicUrl: data.MCP_PUBLIC_URL ?? `http://localhost:${data.PORT}`,
        allowedOrigins: data.MCP_ALLOWED_ORIGINS,
        logLevel: data.LOG_LEVEL,
    };
}
