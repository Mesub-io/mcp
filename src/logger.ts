import type { LogLevel } from './config.js';
import { Secret } from './secret.js';

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
    /** Scrubbed from every line as written, wherever they sit: the service secret. */
    secrets?: readonly Secret[];
}

const REDACTED = '[redacted]';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

// Any field whose name says it holds a credential, whatever the casing.
const SECRET_KEY = /authorization|cookie|token|secret|password|api[-_]?key|signature|credential/i;
// A credential quoted inside a message or an error, after its scheme.
const SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// What Mesub issues to an agent, by its prefix: an access token, a refresh
// token, an authorization code. Anywhere in a string, whatever it is glued
// to: no word boundary is asked for. Eight characters at least, so that
// `format_string` stays what it is.
const MESUB_TOKEN = /m(?:at|rt|ac)_[A-Za-z0-9_-]{8,}/g;
const MAX_DEPTH = 6;

function redactText(text: string): string {
    return text
        .replace(SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`)
        .replace(MESUB_TOKEN, REDACTED);
}

/**
 * A copy safe to log: every credential-named field is replaced, at any depth,
 * and so are a `Secret`, a credential after its scheme and anything shaped
 * like a token Mesub issues, in a string or in the name of a field. Bytes are
 * never written: only how many there were.
 */
export function redact(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redactText(value);
    if (typeof value !== 'object' || value === null) return value;
    if (value instanceof Secret) return REDACTED;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return `[${value.byteLength} bytes]`;
    }
    if (depth >= MAX_DEPTH) return '[truncated]';

    if (value instanceof Error) {
        // Its name, what it says and where it comes from. Nothing else it carries.
        return {
            name: redactText(value.name),
            message: redactText(value.message),
            ...(value.stack !== undefined && { stack: redactText(value.stack) }),
            ...(value.cause !== undefined && { cause: redact(value.cause, depth + 1) }),
        };
    }
    if (value instanceof Headers) return redact(Object.fromEntries(value), depth);
    if (value instanceof Request) return { method: value.method, url: redactText(value.url) };
    if (value instanceof Response) return { status: value.status };
    if (value instanceof Map) return redact(Object.fromEntries(value), depth);
    if (value instanceof Set) return redact([...value], depth);
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            redactText(key),
            SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1),
        ]),
    );
}

/**
 * One JSON object per line. Everything passes through `redact` first, and the
 * line itself through a last net: the secrets the logger was given.
 */
export function createLogger(options: LoggerOptions): Logger {
    const out = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
    const floor = RANK[options.level];
    const secrets = options.secrets ?? [];
    // A secret holds no character JSON escapes: it reads the same in the line.
    const write = (line: string) => out(secrets.reduce((safe, secret) => secret.scrub(safe), line));

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
