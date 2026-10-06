import type { LogLevel } from './config.js';

export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
    level: LogLevel;
    /** Where a line goes. Defaults to stdout. */
    write?: (line: string) => void;
}

const REDACTED = '[redacted]';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

// Any field whose name says it holds a credential, whatever the casing.
const SECRET_KEY = /authorization|cookie|token|secret|password|api[-_]?key|signature|credential/i;
// A bearer credential quoted inside a message or an error.
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_DEPTH = 6;

/**
 * A copy safe to log: every credential-named field is replaced, at any depth,
 * and so is a bearer token quoted inside a string.
 */
export function redact(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return value.replace(BEARER, `Bearer ${REDACTED}`);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= MAX_DEPTH) return '[truncated]';

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redact(value.message),
            ...(value.stack !== undefined && { stack: redact(value.stack) }),
            ...(value.cause !== undefined && { cause: redact(value.cause, depth + 1) }),
        };
    }
    if (value instanceof Headers) return redact(Object.fromEntries(value), depth);
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1),
        ]),
    );
}

/** One JSON object per line. Everything passes through `redact` first. */
export function createLogger(options: LoggerOptions): Logger {
    const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
    const floor = RANK[options.level];

    const log = (level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields) => {
        if (RANK[level] < floor) return;
        const safe = redact(fields ?? {}) as LogFields;
        write(
            JSON.stringify({
                ...safe,
                time: new Date().toISOString(),
                level,
                message: redact(message),
            }),
        );
    };

    return {
        debug: (message, fields) => log('debug', message, fields),
        info: (message, fields) => log('info', message, fields),
        warn: (message, fields) => log('warn', message, fields),
        error: (message, fields) => log('error', message, fields),
    };
}
