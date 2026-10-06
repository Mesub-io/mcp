import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { loadConfig, type Config } from '../src/config.js';
import { createLogger, type Logger } from '../src/logger.js';
import { start, type RunningServer } from '../src/start.js';

/** A token no test may ever find in a log line or a response. */
export const TOKEN = 'test-access-token.abc123';

/** The protocol revision without sessions nor handshake. */
export const MODERN = '2026-07-28';

export interface FakeApiCall {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
}

export interface FakeApi {
    url: string;
    calls: FakeApiCall[];
    /** What every next call is answered with. */
    answer: (status: number, body: unknown, headers?: Record<string, string>) => void;
    /** Keeps every next call waiting until the function it returns is called. */
    hold: () => () => void;
    close: () => Promise<void>;
}

/** A local HTTP server standing for the Mesub API. Answers a healthy `GET /health` at first. */
export async function fakeMesubApi(): Promise<FakeApi> {
    const calls: FakeApiCall[] = [];
    let next = {
        status: 200,
        body: { status: 'ok', uptime: 42 } as unknown,
        headers: {} as Record<string, string>,
    };

    let gate: Promise<void> = Promise.resolve();

    const server = createServer(async (req, res) => {
        calls.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
        await gate;
        res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers });
        res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
    });
    await listen(server);

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        answer: (status, body, headers = {}) => {
            next = { status, body, headers };
        },
        hold: () => {
            let release = () => {};
            gate = new Promise((resolve) => {
                release = resolve;
            });
            return release;
        },
        close: () => close(server),
    };
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

/** The real server on a free port, logging into memory. */
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
    const config = loadConfig({ PORT: '0', LOG_LEVEL: 'debug', ...env });
    const { logger, logs, lines } = memoryLogger();
    const running = await start({ config, logger });
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
    return new Promise((resolve) => server.close(() => resolve()));
}
