import type { ErrorEvent } from '@sentry/node';

import { loadConfig } from '../src/config.js';
import { reportOf, scrubEvent, startErrorReports } from '../src/error-reports.js';
import { createLogger, type LogFields } from '../src/logger.js';
import { Secret } from '../src/secret.js';
import { VERSION } from '../src/version.js';

const SECRET = 'a-service-secret-of-thirty-two-chars!';
const required = { MESUB_SERVICE_SECRET: SECRET, MESUB_ISSUER_URL: 'https://api.mesub.io' };
const DSN = 'https://abc123@o1.ingest.de.sentry.io/42';

describe('the error reports configuration', () => {
    it('is off without a DSN', () => {
        expect(loadConfig(required).errorReports).toBeUndefined();
        expect(startErrorReports(undefined, [])).toBeUndefined();
    });

    it('takes a DSN, the environment it names, and the release the image was built from', () => {
        expect(
            loadConfig({
                ...required,
                SENTRY_DSN: DSN,
                SENTRY_ENVIRONMENT: 'devnet',
                SENTRY_RELEASE: 'b298787',
            }).errorReports,
        ).toEqual({ dsn: DSN, environment: 'devnet', release: 'b298787' });
        expect(loadConfig({ ...required, SENTRY_DSN: DSN }).errorReports).toEqual({
            dsn: DSN,
            environment: 'local',
            release: VERSION,
        });
    });

    it('names the version when the image was built without a commit', () => {
        expect(
            loadConfig({ ...required, SENTRY_DSN: DSN, SENTRY_RELEASE: '' }).errorReports?.release,
        ).toBe(VERSION);
    });

    it('refuses a DSN that is not one', () => {
        expect(() => loadConfig({ ...required, SENTRY_DSN: 'http://nope' })).toThrow(/SENTRY_DSN/);
    });
});

describe('the logger', () => {
    function logged() {
        const reported: [string, LogFields][] = [];
        const logger = createLogger({
            level: 'debug',
            write: () => {},
            report: (message, fields) => reported.push([message, fields]),
        });
        return { logger, reported };
    }

    it('reports an error line, and nothing below it: a refusal said on purpose is info', () => {
        const { logger, reported } = logged();

        logger.info('tool call refused by Mesub', { code: 'not_found' });
        logger.warn('cannot check access tokens', { reason: 'api_unavailable' });
        logger.error('cannot check access tokens', { reason: 'unexpected_answer' });

        expect(reported).toEqual([['cannot check access tokens', { reason: 'unexpected_answer' }]]);
    });

    it('reports what it writes: redacted, never a token nor a header', () => {
        const { logger, reported } = logged();

        logger.error('tool call failed', {
            tool: 'list_plans',
            authorization: 'Bearer mat_abcdefghijkl',
            error: new Error('refused mat_abcdefghijkl'),
        });

        expect(JSON.stringify(reported)).not.toContain('mat_abcdefghijkl');
        expect(reported[0]?.[1]).toMatchObject({ tool: 'list_plans', authorization: '[redacted]' });
    });
});

describe('a report', () => {
    it('carries the error of the line, with its stack', () => {
        const error = reportOf('tool call failed', {
            error: {
                name: 'TypeError',
                message: 'x is undefined',
                stack: 'TypeError: x\n    at f (a.js:1:2)',
            },
        });

        expect(error.name).toBe('TypeError');
        expect(error.message).toBe('x is undefined');
        expect(error.stack).toContain('at f (a.js:1:2)');
    });

    it('is the message itself when the line has no error', () => {
        expect(reportOf('cannot check access tokens', { reason: 'r' }).message).toBe(
            'cannot check access tokens',
        );
    });
});

describe('scrubEvent', () => {
    it('keeps the error and the line, and takes out every token and the service secret', () => {
        const secret = new Secret(SECRET);
        const event = scrubEvent(
            {
                type: undefined,
                message: `secret ${SECRET}`,
                exception: { values: [{ type: 'Error', value: 'refused mat_abcdefghijkl' }] },
                contexts: { log: { hint: `Bearer abc.def and ${SECRET}`, tool: 'list_plans' } },
                request: { headers: { authorization: 'Bearer x' } },
                user: { ip_address: '1.2.3.4' },
                breadcrumbs: [{ message: 'mat_abcdefghijkl' }],
                extra: { anything: 'x' },
            } as ErrorEvent,
            [secret],
        );

        expect(JSON.stringify(event)).not.toContain(SECRET);
        expect(JSON.stringify(event)).not.toContain('mat_abcdefghijkl');
        expect(JSON.stringify(event)).not.toContain('abc.def');
        expect(event.exception?.values?.[0]?.value).toBe('refused [redacted]');
        expect(event.contexts?.log).toMatchObject({ tool: 'list_plans' });
        expect(event.request).toBeUndefined();
        expect(event.user).toBeUndefined();
        expect(event.breadcrumbs).toBeUndefined();
        expect(event.extra).toBeUndefined();
    });
});
