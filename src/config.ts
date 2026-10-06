import type { BlockList } from 'node:net';

import * as z from 'zod';

import { CLIENT_IP_HEADERS, proxyList, type ClientAddressSource } from './client-address.js';
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
    /** Where clients reach this server: an origin, and `<publicUrl>/mcp` is the endpoint. */
    publicUrl: string;
    /** `<publicUrl>/mcp`: the audience a token must have been issued for. */
    resourceUrl: string;
    /** Origins a browser may call from, besides the public URL's own: scheme, host and port. */
    allowedOrigins: string[];
    /** Where the address a request counts as is read. */
    clientAddress: ClientAddressSource;
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
        password === '' &&
        !/[?#]/.test(value)
    );
}

/** A base URL that is an origin and nothing more: no path. */
function isOrigin(value: string): boolean {
    if (!isBaseUrl(value) || /\/\/.*\/\//.test(value)) return false;
    const { pathname, hostname } = new URL(value);
    // A name or an address: no wildcard.
    return pathname === '/' && /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i.test(hostname);
}

/** An https origin, or an http one on this machine: as the API demands of its own. */
function isIssuer(value: string): boolean {
    return isOrigin(value) && (new URL(value).protocol === 'https:' || isLoopback(value));
}

/** How short a service secret may be, as the Mesub API demands of its own copy. */
export const MIN_SERVICE_SECRET_LENGTH = 32;
// Visible ASCII only: it travels in a header, and must never be able to end
// one. No quote nor backslash: it reads the same once JSON has escaped it, at
// any depth, so the logger's last net finds it wherever it hides.
const HEADER_SAFE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

// Stored without its trailing slash.
const baseUrl = z
    .string()
    .refine(isBaseUrl, 'must be an http or https URL, without credentials, query nor fragment')
    .transform((value) => value.replace(/\/+$/, ''));

const list = (value: string) =>
    value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');

const schema = z.object({
    MESUB_API_URL: baseUrl.default('https://api.mesub.io'),
    MESUB_API_PRIVATE_NETWORK: z
        .literal('true', { error: 'must be true, or left unset' })
        .optional(),
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
        .regex(HEADER_SAFE, {
            error: 'must be visible ASCII characters, without a space, a quote nor a backslash',
        }),
    PORT: z.coerce
        .number({ error: 'must be a port number' })
        .int('must be a port number')
        .min(0, 'must be a port number')
        .max(65535, 'must be a port number')
        .default(3000),
    HOST: z.string().default('127.0.0.1'),
    // An origin, so that the resource is `<origin>/mcp` and nothing else: the
    // endpoint is served at /mcp, and its metadata under /.well-known at the root.
    MCP_PUBLIC_URL: z
        .string()
        .refine(
            isOrigin,
            'must be an origin, without a path, credentials, query nor fragment: the endpoint is <origin>/mcp',
        )
        .transform((value) => new URL(value).origin)
        .optional(),
    MCP_ALLOWED_ORIGINS: z
        .string()
        .default('')
        .transform(list)
        .refine(
            (items) => items.every(isOrigin),
            'must be origins separated by commas, each a scheme, a host and a port if any: https://app.example.com',
        )
        .transform((items) => items.map((item) => new URL(item).origin)),
    CLIENT_IP_HEADER: z
        .enum([...CLIENT_IP_HEADERS, 'none'], {
            error: `must be one of ${CLIENT_IP_HEADERS.join(', ')}, or none`,
        })
        .optional(),
    TRUSTED_PROXY_CIDRS: z.string().default('').transform(list),
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
    // The names and what is wrong, never the values.
    const problems = parsed.success
        ? []
        : parsed.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`);
    const refuse = (name: string, message: string) => {
        if (!problems.some((line) => line.startsWith(`${name}: `))) {
            problems.push(`${name}: ${message}`);
        }
    };

    const data = parsed.success ? parsed.data : undefined;
    const publicUrl = data && (data.MCP_PUBLIC_URL ?? `http://localhost:${data.PORT}`);
    let trustedProxies: BlockList | undefined;

    if (data && publicUrl !== undefined) {
        // The service secret and every token travel to the API: in clear only
        // on this machine, or on a network somebody vouched for.
        if (
            data.MESUB_API_URL.startsWith('http:') &&
            !isLoopback(data.MESUB_API_URL) &&
            data.MESUB_API_PRIVATE_NETWORK !== 'true'
        ) {
            refuse(
                'MESUB_API_URL',
                'must be https. Plain http is for this machine, or for a private network once MESUB_API_PRIVATE_NETWORK=true says it is one',
            );
        }
        // Nothing is assumed about what stands in front of a hosted server.
        if (data.CLIENT_IP_HEADER === undefined && !isLoopback(publicUrl)) {
            refuse(
                'CLIENT_IP_HEADER',
                `is required when MCP_PUBLIC_URL is not on this machine: ${CLIENT_IP_HEADERS.join(' or ')}, whichever the proxy in front writes, or none to count the socket peer`,
            );
        }
        if (data.TRUSTED_PROXY_CIDRS.length > 0) {
            if (data.CLIENT_IP_HEADER !== 'cf-connecting-ip') {
                refuse(
                    'TRUSTED_PROXY_CIDRS',
                    'only means something with CLIENT_IP_HEADER=cf-connecting-ip',
                );
            } else {
                try {
                    trustedProxies = proxyList(data.TRUSTED_PROXY_CIDRS);
                } catch {
                    refuse(
                        'TRUSTED_PROXY_CIDRS',
                        'must be CIDR ranges separated by commas: 203.0.113.0/24, 2001:db8::/32',
                    );
                }
            }
        }
    }

    if (!data || publicUrl === undefined || problems.length > 0) {
        throw new ConfigError(
            `Invalid configuration:\n${problems
                .sort()
                .map((line) => `  ${line}`)
                .join('\n')}`,
        );
    }

    return {
        mesubApiUrl: data.MESUB_API_URL,
        issuerUrl: data.MESUB_ISSUER_URL,
        serviceSecret: new Secret(data.MESUB_SERVICE_SECRET),
        port: data.PORT,
        host: data.HOST,
        publicUrl,
        resourceUrl: `${publicUrl}/mcp`,
        allowedOrigins: data.MCP_ALLOWED_ORIGINS,
        clientAddress: {
            header: data.CLIENT_IP_HEADER === 'none' ? undefined : data.CLIENT_IP_HEADER,
            trustedProxies,
        },
        logLevel: data.LOG_LEVEL,
    };
}

/**
 * The configuration of the process, read once: the service secret is taken
 * OUT of the environment as it is read, so nothing that runs later, a
 * dependency included, finds it in `process.env`.
 */
export function takeConfig(env: Record<string, string | undefined>): Config {
    try {
        return loadConfig(env);
    } finally {
        delete env.MESUB_SERVICE_SECRET;
    }
}
