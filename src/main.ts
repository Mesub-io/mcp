import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { start } from './start.js';

async function main(): Promise<void> {
    let config;
    try {
        config = loadConfig(process.env);
    } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }

    const logger = createLogger({ level: config.logLevel });
    const server = await start({ config, logger });

    const shutdown = (signal: string) => {
        logger.info('shutting down', { signal });
        void server.stop().then(() => process.exit(0));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
