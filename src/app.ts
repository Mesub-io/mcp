import {
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
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
    /** Tests only: a shorter wait for the API to answer a tool. */
    apiTimeoutMs?: number;
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a browser may call from this origin. An origin is a scheme, a host
 * AND a port, compared whole: `http://mcp.example.com` is not
 * `https://mcp.example.com`, nor is `https://mcp.example.com:8443`.
 *
 * Allowed: the public URL's own origin and those configured. Run locally,
 * a page of this machine as well, on any port: that is where a developer's
 * tools are served from, and a page of another machine is still refused.
 */
export function originAllowed(origin: string, config: Config): boolean {
    // As a browser writes one: what parses back to itself, and nothing else.
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) return false;
    if (origin === config.publicUrl || config.allowedOrigins.includes(origin)) return true;

    const { protocol, hostname } = new URL(origin);
    return (
        isLoopback(config.publicUrl) &&
        (protocol === 'http:' || protocol === 'https:') &&
        LOOPBACK_HOSTS.has(hostname)
    );
}

/** An Origin header fit for a log line: as it came when it is one, a label otherwise. */
function loggableOrigin(origin: string): string {
    return origin.length <= 200 && URL.canParse(origin) && new URL(origin).origin === origin
        ? origin
        : `[not an origin, ${origin.length} characters]`;
}

/**
 * 403, readable by the page that was refused: it says no and nothing else,
 * to anybody, so any origin may read it. A preflight still fails, as it must.
 */
function forbidden(message: string): Response {
    return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
        { status: 403, headers: { 'Access-Control-Allow-Origin': '*', Vary: 'Origin' } },
    );
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
        const origin = c.req.header('origin');
        const address = () => auth.addressOf(c.req.raw, c.env?.incoming?.socket?.remoteAddress);

        if (origin !== undefined && !originAllowed(origin, config)) {
            auth.note(address(), 'warn', 'origin refused', { origin: loggableOrigin(origin) });
            return forbidden('This origin may not call the Mesub MCP server.');
        }
        if (local && hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames())) {
            auth.note(address(), 'warn', 'host refused', {});
            return forbidden('This host is not the Mesub MCP server.');
        }
        return next();
    });

    // An origin let through is a browser: it gets the CORS headers it needs,
    // and the answer to its preflight.
    app.use(
        '/mcp',
        cors({
            origin: (origin) => (originAllowed(origin, config) ? origin : null),
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
