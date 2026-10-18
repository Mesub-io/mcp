import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import type { ErrorReportsConfig } from './config.js';
import { type LogFields, redact } from './logger.js';
import type { Secret } from './secret.js';

/**
 * Unexpected errors to Sentry's `mcp` project, EU region (#54).
 *
 * What is sent is an error line of the logger, after the logger redacted it:
 * no tool argument, no token, no service secret, no header. A refusal
 * answered on purpose is logged as info and never reaches here. `scrubEvent`
 * is a last net over what Sentry adds around it.
 *
 * Errors only: no tracing, no instrumentation of the process, and nothing the
 * SDK would collect on its own.
 */
export interface ErrorReports {
    report(message: string, fields: LogFields): void;
    /** Sends what is still queued, before the process exits. */
    flush(): Promise<void>;
}

const FLUSH_TIMEOUT_MS = 2000;

/** The error a line stands for: the one it carries (redacted, with its stack), or its message. */
export function reportOf(message: string, fields: LogFields): Error {
    const carried = fields.error;
    if (carried && typeof carried === 'object' && 'message' in carried) {
        const {
            name,
            message: said,
            stack,
        } = carried as {
            name?: unknown;
            message?: unknown;
            stack?: unknown;
        };
        const error = new Error(String(said));
        if (typeof name === 'string') error.name = name;
        if (typeof stack === 'string') error.stack = stack;
        return error;
    }

    const error = new Error(message);
    Error.captureStackTrace(error, reportOf);
    return error;
}

/** Every string inside `value`, redacted and with the given secrets taken out. */
function scrubDeep(value: unknown, secrets: readonly Secret[]): unknown {
    const redacted = redact(value);
    if (typeof redacted === 'string')
        return secrets.reduce((text, secret) => secret.scrub(text), redacted);
    if (Array.isArray(redacted)) return redacted.map((item) => scrubDeep(item, secrets));
    if (redacted && typeof redacted === 'object')
        return Object.fromEntries(
            Object.entries(redacted).map(([key, item]) => [key, scrubDeep(item, secrets)]),
        );
    return redacted;
}

/** Sentry's `beforeSend`: the error and its line, nothing about the request or the caller. */
export function scrubEvent(event: ErrorEvent, secrets: readonly Secret[]): ErrorEvent {
    const scrubbed: ErrorEvent = { ...event };
    delete scrubbed.request;
    delete scrubbed.user;
    delete scrubbed.breadcrumbs;
    delete scrubbed.extra;

    if (event.message) scrubbed.message = scrubDeep(event.message, secrets) as string;
    if (event.exception?.values)
        scrubbed.exception = {
            ...event.exception,
            values: event.exception.values.map((value) =>
                value.value
                    ? { ...value, value: scrubDeep(value.value, secrets) as string }
                    : value,
            ),
        };
    if (event.contexts)
        scrubbed.contexts = scrubDeep(event.contexts, secrets) as NonNullable<
            ErrorEvent['contexts']
        >;
    if (event.tags)
        scrubbed.tags = scrubDeep(event.tags, secrets) as NonNullable<ErrorEvent['tags']>;

    return scrubbed;
}

/** Starts the reports; none without a configuration (no SENTRY_DSN). */
export function startErrorReports(
    config: ErrorReportsConfig | undefined,
    secrets: readonly Secret[],
): ErrorReports | undefined {
    if (!config) return undefined;

    Sentry.init({
        dsn: config.dsn,
        environment: config.environment,
        release: config.release,
        // Nothing patched, nothing traced: the two that report a crash.
        defaultIntegrations: false,
        integrations: [
            Sentry.onUncaughtExceptionIntegration(),
            Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
        ],
        // Every category spelled out: one left unset is collected.
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
            databaseQueryData: false,
            stackFrameVariables: false,
            queues: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
        },
        beforeSend: (event) => scrubEvent(event, secrets),
    });

    return {
        report(message, fields) {
            const { error: _carried, ...context } = fields;
            void _carried;
            Sentry.withScope((scope) => {
                scope.setContext('log', { message, ...context });
                // One issue per kind of line: they all share the logger's stack.
                scope.setFingerprint([
                    message,
                    String(fields.reason ?? fields.code ?? fields.tool ?? ''),
                ]);
                Sentry.captureException(reportOf(message, fields));
            });
        },
        async flush() {
            await Sentry.flush(FLUSH_TIMEOUT_MS);
        },
    };
}
