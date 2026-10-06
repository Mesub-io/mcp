import * as z from 'zod';

import { WEBHOOK_EVENTS } from '../mesub/schemas.js';
import { idInput } from './inputs.js';

export const MAX_WEBHOOK_URL_LENGTH = 2048;

export const webhookId = idInput('The id of the webhook endpoint, as `list_webhooks` returns it.');

/** Https, no credentials: what can be told without resolving it. The API checks the host is public. */
function publicLooking(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const { protocol, username, password } = new URL(value);
    return protocol === 'https:' && username === '' && password === '';
}

export const webhookUrl = (what: string) =>
    z
        .string()
        .max(MAX_WEBHOOK_URL_LENGTH)
        .refine(publicLooking, { message: 'An https URL, without a user name or a password.' })
        .describe(what);

export const webhookEvent = z.enum(WEBHOOK_EVENTS);

export const webhookEvents = (what: string) =>
    z
        .array(webhookEvent)
        .min(1)
        .max(WEBHOOK_EVENTS.length)
        .refine((events) => new Set(events).size === events.length, {
            message: 'No event twice.',
        })
        .describe(what);
