import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { AppDependencies } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createLogger, type Logger } from '../src/logger.js';
import { start, type RunningServer } from '../src/start.js';

/** An agent's access token no test may ever find in a log line or a response. */
export const TOKEN = 'mat_test-access-token-abc123_XYZ';

/** The service secret no test may ever find in a log line or a response. */
export const SERVICE_SECRET = 'test-service-secret-0123456789-abcdefghij';

/** Where the test servers say clients reach them, and the resource a token is issued for. */
export const PUBLIC_URL = 'http://localhost:3334';
export const RESOURCE = `${PUBLIC_URL}/mcp`;
export const METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;

/** The one challenge every 401 carries. */
export const CHALLENGE = `Bearer error="invalid_token", error_description="A valid Mesub access token is required.", resource_metadata="${METADATA_URL}"`;

/** The protocol revision without sessions nor handshake. */
export const MODERN = '2026-07-28';

export interface FakeApiCall {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
}

export interface FakeConnection {
    connection_id: string;
    project: { id: string; name: string };
    client: { id: string; name: string };
    scope: string;
    audience: string;
    issuer: string;
    expires_at: number;
}

interface Answer {
    status: number;
    body: unknown;
    headers: Record<string, string>;
}

export interface FakeApi {
    url: string;
    /** Every call received, `/agent/whoami` included. */
    calls: FakeApiCall[];
    callsTo: (path: string) => FakeApiCall[];
    /** What every next call to a route other than `/agent/whoami` is answered with. */
    answer: (status: number, body: unknown, headers?: Record<string, string>) => void;
    /** Issues a token: a live connection `/agent/whoami` vouches for. */
    issue: (token: string, overrides?: Partial<FakeConnection>) => FakeConnection;
    /** Revokes a token's connection, as a merchant does from the dashboard. */
    revoke: (token: string) => void;
    /** Answers every next `/agent/whoami` with this, whatever it carries. Undefined: back to normal. */
    whoami: (answer?: { status: number; body: unknown; headers?: Record<string, string> }) => void;
    /** Changes the service secret the API expects. */
    expectSecret: (secret: string) => void;
    /** Keeps every next call to a route other than `/agent/whoami` waiting. */
    hold: () => () => void;
    /** Keeps every next `/agent/whoami` waiting. */
    holdWhoami: () => () => void;
    /** Makes every `/agent/whoami` take this long, in milliseconds. */
    delayWhoami: (ms: number) => void;
    /**
     * Takes over: every next call goes to this instead, raw. Returning false
     * hands the call back to the fake. Undefined: back to normal.
     */
    intercept: (handler?: (req: IncomingMessage, res: ServerResponse) => boolean) => void;
    /** Whether the fake would vouch for a token right now. */
    knows: (token: string) => FakeConnection | undefined;
    /**
     * Calls the fake still has an answer open for: what a client that gave up
     * must have let go of. Not sockets: a client may open an idle one again.
     */
    pending: () => number;
    close: () => Promise<void>;
}

const refusal = (code: string, message: string) => ({
    statusCode: 401,
    message,
    error: 'Unauthorized',
    code,
    retryable: false,
});

/**
 * A local HTTP server standing for the Mesub API. `GET /agent/whoami` behaves
 * as the real one: the service secret first, then the token. Everything else
 * answers a healthy `GET /health` until told otherwise. `TOKEN` is issued.
 */
export async function fakeMesubApi(): Promise<FakeApi> {
    const calls: FakeApiCall[] = [];
    const connections = new Map<string, FakeConnection>();
    let secret = SERVICE_SECRET;
    let next: Answer = { status: 200, body: { status: 'ok', uptime: 42 }, headers: {} };
    let forced: Answer | undefined;
    let gate: Promise<void> = Promise.resolve();
    let whoamiGate: Promise<void> = Promise.resolve();
    let delay = 0;
    let interceptor: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
    let pending = 0;

    const whoami = (headers: IncomingHttpHeaders): Answer => {
        if (forced) return forced;
        if (headers['x-mesub-service-secret'] !== secret) {
            return {
                status: 401,
                body: refusal(
                    'invalid_service_credentials',
                    'This route is for the Mesub MCP server.',
                ),
                headers: {},
            };
        }
        const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
        const connection = token === undefined ? undefined : connections.get(token);
        if (!connection || connection.expires_at <= Date.now() / 1000) {
            return {
                status: 401,
                body: refusal('invalid_agent_token', 'That access token is not valid.'),
                headers: {},
            };
        }
        return { status: 200, body: connection, headers: { 'Cache-Control': 'no-store' } };
    };

    const server = createServer(async (req, res) => {
        const path = req.url ?? '';
        calls.push({ method: req.method ?? '', path, headers: req.headers });
        pending += 1;
        res.on('close', () => (pending -= 1));
        if (interceptor?.(req, res)) return;
        const isWhoami = path === '/agent/whoami';
        await (isWhoami ? whoamiGate : gate);
        if (isWhoami && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const { status, body, headers } = isWhoami ? whoami(req.headers) : next;
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await listen(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const holder = (set: (promise: Promise<void>) => void) => () => {
        let release = () => {};
        set(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        return release;
    };

    const api: FakeApi = {
        url,
        calls,
        callsTo: (path) => calls.filter((call) => call.path === path),
        answer: (status, body, headers = {}) => {
            next = { status, body, headers };
        },
        issue: (token, overrides = {}) => {
            const connection: FakeConnection = {
                connection_id: `conn_${connections.size + 1}`,
                project: { id: 'proj_1', name: 'Fraise' },
                client: { id: 'mcp_client_1', name: 'Test agent' },
                scope: 'mesub',
                audience: RESOURCE,
                issuer: url,
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                ...overrides,
            };
            connections.set(token, connection);
            return connection;
        },
        revoke: (token) => void connections.delete(token),
        whoami: (answer) => {
            forced = answer && { headers: {}, ...answer };
        },
        expectSecret: (value) => {
            secret = value;
        },
        hold: holder((promise) => {
            gate = promise;
        }),
        holdWhoami: holder((promise) => {
            whoamiGate = promise;
        }),
        delayWhoami: (ms) => {
            delay = ms;
        },
        intercept: (handler) => {
            interceptor = handler;
        },
        knows: (token) => {
            const connection = connections.get(token);
            return connection && connection.expires_at > Date.now() / 1000 ? connection : undefined;
        },
        pending: () => pending,
        close: () => close(server),
    };
    api.issue(TOKEN);
    return api;
}

/** A URL of this machine nothing listens on. */
export async function deadUrl(): Promise<string> {
    const server = createServer();
    await listen(server);
    const { port } = server.address() as AddressInfo;
    await close(server);
    return `http://127.0.0.1:${port}`;
}

export interface TestServer extends RunningServer {
    url: string;
    config: Config;
    /** Every log line written, parsed. */
    logs: Record<string, unknown>[];
    /** The same, as written. */
    lines: string[];
}

export type TestOverrides = Omit<AppDependencies, 'config' | 'logger'>;

/**
 * The real server on a free port, logging into memory. Never the real Mesub
 * API: without `MESUB_API_URL` it points at an address nothing listens on.
 * The issuer is the API's own URL unless told otherwise, as the fake answers.
 */
export async function startServer(
    env: Record<string, string> = {},
    overrides: TestOverrides = {},
): Promise<TestServer> {
    const apiUrl = env.MESUB_API_URL ?? (await deadUrl());
    const config = loadConfig({
        PORT: '0',
        LOG_LEVEL: 'debug',
        MCP_PUBLIC_URL: PUBLIC_URL,
        MESUB_SERVICE_SECRET: SERVICE_SECRET,
        // The fakes are plain http on this machine: said so for a hosted public URL.
        MESUB_API_PRIVATE_NETWORK: 'true',
        CLIENT_IP_HEADER: 'none',
        MESUB_ISSUER_URL: apiUrl,
        ...env,
        MESUB_API_URL: apiUrl,
    });
    const { logger, logs, lines } = memoryLogger();
    const running = await start({ config, logger, ...overrides });
    return { ...running, url: `http://127.0.0.1:${running.port}`, config, logs, lines };
}

export function memoryLogger(): {
    logger: Logger;
    logs: Record<string, unknown>[];
    lines: string[];
} {
    const lines: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger({
        level: 'debug',
        write: (line) => {
            lines.push(line);
            logs.push(JSON.parse(line) as Record<string, unknown>);
        },
    });
    return { logger, logs, lines };
}

export interface ConnectOptions {
    token?: string;
    /** Pins the client to the modern revision instead of the 2025 handshake. */
    modern?: boolean;
    fetch?: typeof fetch;
}

/** The SDK's own client, over HTTP, as a merchant's agent would connect. */
export async function connect(url: string, options: ConnectOptions = {}): Promise<Client> {
    const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        options.modern ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        authProvider: { token: async () => options.token ?? TOKEN },
        ...(options.fetch && { fetch: options.fetch }),
    });
    await client.connect(transport);
    return client;
}

/** A raw JSON-RPC POST to `/mcp`, for what the SDK's client would not send. */
export function post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<Response> {
    return fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

export const bearer = (token: string = TOKEN) => ({ Authorization: `Bearer ${token}` });

/** A raw `tools/call`, with no handshake before it. */
export function callTool(
    url: string,
    name: string,
    args: Record<string, unknown> = {},
    headers: Record<string, string> = bearer(),
): Promise<Response> {
    return post(
        url,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        { 'MCP-Protocol-Version': '2025-06-18', ...headers },
    );
}

/** The JSON-RPC message of a response, sent as JSON or as one SSE event. */
export async function readJsonRpc(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        return JSON.parse(text);
    }
    const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== '');
    return JSON.parse(data.at(-1) ?? 'null');
}

export const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
    },
};

function listen(server: Server): Promise<void> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}
