import {
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    originValidationResponse,
    validateOriginHeader,
    type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { createAuthenticator } from './auth.js';
import { isLoopback, type Config } from './config.js';
import type { Logger } from './logger.js';
import type { Limits } from './rate-limit.js';
import { createMesubMcpHandler } from './server.js';
import type { AnyTool } from './tools/index.js';
import { SERVER_NAME, VERSION } from './version.js';

export interface AppDependencies {
    config: Config;
    logger: Logger;
    /** Tests only: the fetch the Mesub client calls. */
    fetch?: typeof fetch;
    /** Tests only: the clock of the limits and of a token's expiry. */
    now?: () => number;
    /** Tests only: smaller limits. */
    limits?: Partial<Limits>;
    /** Tests only: a shorter wait for the API to vouch for a token. */
    verifyTimeoutMs?: number;
    /** Tests only: the tools to register instead of the server's own. */
    tools?: readonly AnyTool[];
}

/** What the Node server hands over with a request: the socket it came on. */
interface NodeBindings {
    incoming?: { socket?: { remoteAddress?: string } };
}

export interface App {
    /** The whole HTTP surface, as a web-standard handler. `env` is the Node server's. */
    fetch: (request: Request, env?: unknown) => Response | Promise<Response>;
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

/**
 * `GET /health`, the protected resource metadata, and the MCP endpoint at
 * `/mcp` behind its guards. Nothing else, and nothing but `/mcp` is protected:
 * every request to it needs a valid token, whatever its method or its body.
 */
export function createApp(dependencies: AppDependencies): App {
    const { config, logger } = dependencies;
    const auth = createAuthenticator(dependencies);
    const mcp: McpHttpHandler = createMesubMcpHandler({
        logger,
        mesubFor: auth.mesubFor,
        ...(dependencies.tools && { tools: dependencies.tools }),
    });
    const origins = allowedOrigins(config);
    const local = isLoopback(config.publicUrl);

    const app = new Hono<{ Bindings: NodeBindings }>();

    app.get('/health', (c) => c.json({ status: 'ok', name: SERVER_NAME, version: VERSION }));

    // RFC 9728, as the MCP authorization specification requires: where a client
    // learns which authorization server to go to. Public, and readable from
    // any origin. Served at the path of the MCP endpoint, which the 401 names,
    // and at the root, where a client that ignores the header looks next.
    for (const path of auth.metadataPaths) {
        app.all(path, (c) => auth.metadata(c.req.raw));
    }

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
            exposeHeaders: ['WWW-Authenticate', 'Retry-After'],
            maxAge: 600,
        }),
    );

    app.all('/mcp', async (c) => {
        // The auth seam: see src/auth.ts. Before the body is read, and before
        // the method is looked at: an initialize, a notification or a GET
        // without a valid token gets the same 401 as a tool call.
        const caller = await auth.authenticate(c.req.raw, c.env?.incoming?.socket?.remoteAddress);
        if (caller instanceof Response) return caller;

        return mcp.fetch(c.req.raw, { authInfo: caller });
    });

    app.notFound((c) => c.json({ error: 'not_found' }, 404));

    app.onError((error, c) => {
        logger.error('request failed', { method: c.req.method, path: c.req.path, error });
        return c.json({ error: 'internal_error' }, 500);
    });

    return {
        fetch: (request, env) => app.fetch(request, env as NodeBindings | undefined),
        close: () => mcp.close(),
    };
}
