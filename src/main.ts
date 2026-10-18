import { ConfigError, takeConfig } from './config.js';
import { startErrorReports } from './error-reports.js';
import { createLogger } from './logger.js';
import { start } from './start.js';

async function main(): Promise<void> {
    let config;
    try {
        // Read once, and the service secret taken out of the environment with it.
        config = takeConfig(process.env);
    } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }

    // Started before anything can fail, so a crash at start is reported too.
    const reports = startErrorReports(config.errorReports, [config.serviceSecret]);
    const logger = createLogger({
        level: config.logLevel,
        secrets: [config.serviceSecret],
        ...(reports && { report: reports.report }),
    });
    const server = await start({ config, logger });

    const shutdown = (signal: string) => {
        logger.info('shutting down', { signal });
        void server
            .stop()
            .then(() => reports?.flush())
            .then(() => process.exit(0));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
