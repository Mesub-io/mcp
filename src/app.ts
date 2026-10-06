import {
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    originValidationResponse,
    validateOriginHeader,
    type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { authenticate } from './auth.js';
import { isLoopback, type Config } from './config.js';
import type { Logger } from './logger.js';
import { createMesubMcpHandler } from './server.js';
import { SERVER_NAME, VERSION } from './version.js';

export interface AppDependencies {
    config: Config;
    logger: Logger;
    /** Tests only: the fetch the Mesub client calls. */
    fetch?: typeof fetch;
}

export interface App {
    /** The whole HTTP surface, as a web-standard handler. */
    fetch: (request: Request) => Response | Promise<Response>;
    /** Ends the MCP exchanges still running. */
    close: () => Promise<void>;
}

/** Hostnames a browser may call from: the server's own, and those configured. */
export function allowedOrigins(config: Config): string[] {
    return [
        new URL(config.publicUrl).hostname,
        ...(isLoopback(config.publicUrl) ? localhostAllowedHostnames() : []),
        ...config.allowedOrigins,
    ];
}

/** `GET /health`, and the MCP endpoint at `/mcp` behind its guards. */
export function createApp(dependencies: AppDependencies): App {
    const { config, logger } = dependencies;
    const mcp: McpHttpHandler = createMesubMcpHandler(dependencies);
    const origins = allowedOrigins(config);
    const local = isLoopback(config.publicUrl);

    const app = new Hono();

    app.get('/health', (c) => c.json({ status: 'ok', name: SERVER_NAME, version: VERSION }));

    // MCP specification 2026-07-28, Streamable HTTP, "Security & Endpoint":
    // "Servers MUST validate the Origin header on all incoming connections to
    // prevent DNS rebinding attacks. If the Origin header is present and
    // invalid, servers MUST respond with HTTP 403 Forbidden." A request
    // without an Origin passes: only browsers send one. Run locally, the Host
    // header is checked too, which is what a rebound DNS name gives away.
    app.use('/mcp', async (c, next) => {
        const refused =
            originValidationResponse(c.req.raw, origins) ??
            (local
                ? hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames())
                : undefined);
        return refused ?? next();
    });

    // An origin let through is a browser: it gets the CORS headers it needs,
    // and the answer to its preflight.
    app.use(
        '/mcp',
        cors({
            origin: (origin) => (validateOriginHeader(origin, origins).ok ? origin : null),
            allowMethods: ['POST'],
            allowHeaders: [
                'Authorization',
                'Content-Type',
                'Accept',
                'MCP-Protocol-Version',
                'Mcp-Method',
                'Mcp-Name',
            ],
            exposeHeaders: ['WWW-Authenticate'],
            maxAge: 600,
        }),
    );

    app.all('/mcp', async (c) => {
        // The auth seam: see src/auth.ts.
        const caller = authenticate(c.req.raw, config);
        if (caller instanceof Response) return caller;

        return mcp.fetch(c.req.raw, { authInfo: caller });
    });

    app.notFound((c) => c.json({ error: 'not_found' }, 404));

    app.onError((error, c) => {
        logger.error('request failed', { method: c.req.method, path: c.req.path, error });
        return c.json({ error: 'internal_error' }, 500);
    });

    return { fetch: (request) => app.fetch(request), close: () => mcp.close() };
}
