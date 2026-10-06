import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';

import { createApp, type AppDependencies } from './app.js';
import { isLoopback } from './config.js';
import { SERVER_NAME, VERSION } from './version.js';

/** How long a request still running gets to end once the process is told to stop. */
const SHUTDOWN_GRACE_MS = 10_000;

export interface RunningServer {
    /** The port actually bound: the one asked for, or a free one for port 0. */
    port: number;
    /** Stops accepting, lets running requests end, then closes what is left. */
    stop: () => Promise<void>;
}

/** Binds the app and resolves once it listens. */
export async function start(dependencies: AppDependencies): Promise<RunningServer> {
    const { config, logger } = dependencies;
    const app = createApp(dependencies);

    const server = await new Promise<Server>((resolve, reject) => {
        const listening = serve(
            { fetch: app.fetch, port: config.port, hostname: config.host },
            () => resolve(listening),
        ) as Server;
        listening.once('error', reject);
    });
    const { port } = server.address() as AddressInfo;

    if (!isLoopback(config.mesubApiUrl) && config.mesubApiUrl.startsWith('http:')) {
        logger.warn(
            'MESUB_API_URL is plain http: access tokens and the service secret travel in clear, on a network MESUB_API_PRIVATE_NETWORK says is private',
        );
    }
    if (!isLoopback(config.publicUrl) && config.publicUrl.startsWith('http:')) {
        logger.warn(
            'MCP_PUBLIC_URL is plain http: access tokens travel in clear between the clients and this server',
        );
    }
    if (!isLoopback(config.publicUrl) && config.clientAddress.header === undefined) {
        logger.warn(
            'CLIENT_IP_HEADER is none: behind a proxy, every caller counts as one address. Nobody is refused for it, but tokens this instance has not seen yet share the few checks one address gets at a time',
        );
    }
    logger.info('listening', {
        name: SERVER_NAME,
        version: VERSION,
        host: config.host,
        port,
        publicUrl: config.publicUrl,
        resourceUrl: config.resourceUrl,
        issuerUrl: config.issuerUrl,
        mesubApiUrl: config.mesubApiUrl,
        clientAddress: config.clientAddress.header ?? 'socket peer',
        trustedProxies: config.clientAddress.trustedProxies !== undefined,
    });
    // On a line of its own: the one value that must be the same on both sides.
    logger.info('resource', {
        resourceUrl: config.resourceUrl,
        hint: "Tokens are taken for this resource only: the Mesub API's MCP_RESOURCE_URL must be exactly this.",
    });

    let stopping: Promise<void> | undefined;
    const stop = () =>
        (stopping ??= new Promise<void>((resolve) => {
            // A kept-alive socket with no request on it would hold `close` back,
            // and one becomes idle each time a running request ends.
            const idle = setInterval(() => server.closeIdleConnections(), 50);
            // Past the grace, what still runs is cut.
            const force = setTimeout(() => {
                void app.close();
                server.closeAllConnections();
            }, SHUTDOWN_GRACE_MS);

            server.close(() => {
                clearInterval(idle);
                clearTimeout(force);
                void app.close().then(resolve, resolve);
            });
        }));

    return { port, stop };
}
