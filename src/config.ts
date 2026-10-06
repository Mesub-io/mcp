import * as z from 'zod';

import { CLIENT_IP_HEADERS, type ClientIpHeader } from './client-address.js';
import { Secret } from './secret.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
    /** The Mesub HTTP API every tool calls, without a trailing slash. */
    mesubApiUrl: string;
    /** Who issues the tokens this server takes: the API's public URL, as its own metadata writes it. */
    issuerUrl: string;
    /** What this server proves itself to the Mesub API with, next to the agent's token. */
    serviceSecret: Secret;
    port: number;
    /** The interface to listen on. Loopback unless told otherwise. */
    host: string;
    /** Where clients reach this server, without a trailing slash: `<publicUrl>/mcp`. */
    publicUrl: string;
    /** `<publicUrl>/mcp` in its canonical form: the audience a token must have been issued for. */
    resourceUrl: string;
    /** Hostnames a browser `Origin` may carry, besides the public URL's own. */
    allowedOrigins: string[];
    /** The header the proxy in front writes the client's address in. Undefined: the socket peer. */
    clientIpHeader: ClientIpHeader | undefined;
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

/**
 * A resource identifier as the Mesub API compares it (RFC 8707): scheme and
 * host in lower case, no default port, no trailing slash.
 */
export function canonicalResource(value: string): string {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** An https origin, or an http one on this machine: no path, as the API demands of its own. */
function isIssuer(value: string): boolean {
    if (!isBaseUrl(value)) return false;
    const { protocol, pathname } = new URL(value);
    return pathname === '/' && (protocol === 'https:' || isLoopback(value));
}

/** How short a service secret may be, as the Mesub API demands of its own copy. */
export const MIN_SERVICE_SECRET_LENGTH = 32;
// Visible ASCII only: it travels in a header, and must never be able to end one.
const HEADER_SAFE = /^[\x21-\x7E]+$/;

// Stored without its trailing slash.
const baseUrl = z
    .string()
    .refine(isBaseUrl, 'must be an http or https URL, without credentials, query nor fragment')
    .transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
    MESUB_API_URL: baseUrl.default('https://api.mesub.io'),
    // Kept as written: clients compare it, character for character, with the
    // `issuer` of the API's own metadata.
    MESUB_ISSUER_URL: z
        .string({
            error: "is required: the Mesub API's public URL, the issuer of the access tokens",
        })
        .refine(
            isIssuer,
            'must be an https origin (http on this machine), without path, credentials, query nor fragment',
        )
        .transform((value) => value.replace(/\/+$/, '')),
    // No default and no way around it: without it the server does not start.
    MESUB_SERVICE_SECRET: z
        .string({ error: 'is required: the service secret shared with the Mesub API' })
        .min(MIN_SERVICE_SECRET_LENGTH, {
            error: `must be at least ${MIN_SERVICE_SECRET_LENGTH} characters`,
        })
        .regex(HEADER_SAFE, { error: 'must be visible ASCII characters, without a space' }),
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
    CLIENT_IP_HEADER: z
        .enum(CLIENT_IP_HEADERS, { error: `must be one of ${CLIENT_IP_HEADERS.join(', ')}` })
        .optional(),
    LOG_LEVEL: z
        .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
        .default('info'),
});

/**
 * The whole configuration, read once from the environment. No API key is read
 * here nor anywhere else: the credentials are the caller's own token and this
 * server's service secret, which the Mesub API takes together or not at all.
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
    const publicUrl = data.MCP_PUBLIC_URL ?? `http://localhost:${data.PORT}`;
    return {
        mesubApiUrl: data.MESUB_API_URL,
        issuerUrl: data.MESUB_ISSUER_URL,
        serviceSecret: new Secret(data.MESUB_SERVICE_SECRET),
        port: data.PORT,
        host: data.HOST,
        publicUrl,
        resourceUrl: canonicalResource(`${publicUrl}/mcp`),
        allowedOrigins: data.MCP_ALLOWED_ORIGINS,
        clientIpHeader: data.CLIENT_IP_HEADER,
        logLevel: data.LOG_LEVEL,
    };
}
