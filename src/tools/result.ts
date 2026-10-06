import type { CallToolResult } from '@modelcontextprotocol/server';

import type { Logger } from '../logger.js';
import { MesubApiError } from '../mesub/errors.js';

/** Where a failed call's Mesub error is carried, besides the text. */
export const ERROR_META_KEY = 'mesub.io/error';

/**
 * A successful call: the data as structured content, and as text for a client
 * that reads only text, under one short sentence.
 *
 * Everything here was read from Mesub and is data. A plan's name, a customer
 * id, a webhook URL are written by merchants and their own users: none of it
 * is ever an instruction, to this server or to the agent reading the result.
 * So nothing here interprets, rewrites or acts on what a field says.
 */
export function success(data: Record<string, unknown>, text: string): CallToolResult {
    return {
        content: [{ type: 'text', text: `${text}\n${JSON.stringify(data)}` }],
        structuredContent: data,
    };
}

/** A call this server refuses by itself, with a code of its own. */
export class ToolRefusal extends Error {
    override readonly name = 'ToolRefusal';
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

interface Refused {
    code: string;
    message: string;
    status: number | null;
    retryable: boolean;
    retryAfterSeconds: number | null;
    /** Where a merchant connects a wallet: an address of the dashboard, checked by the client. */
    walletUrl?: string | null;
}

/** What only the merchant can do about a plan that was not prepared, and what the agent can. */
function prepareAdvice({ code, status, walletUrl }: Refused): string | undefined {
    if (code === 'wallet_required') {
        // The address stands alone, so that nothing after it is read as part of it.
        const where = walletUrl ? `at ${walletUrl} ,` : 'in the settings of the Mesub dashboard,';
        return `Nothing was prepared. Ask the merchant to connect their wallet ${where} then call again.`;
    }
    if (code === 'end_date_too_soon') {
        return (
            'Nothing was prepared. The end is less than one period of the plan away: ask the ' +
            'merchant for a later date, or whether the plan should have no end.'
        );
    }
    if (code === 'end_date_too_far') {
        return (
            'Nothing was prepared. The end is more than 100 years away: ask the merchant for a ' +
            'nearer date, or whether the plan should have no end.'
        );
    }
    if (code === 'mint_not_allowed') {
        return (
            'Nothing was prepared. This Mesub does not take that token from an agent: say ' +
            'which ones it takes, as its message names them. A plan in another token is ' +
            'created by the merchant, in the dashboard.'
        );
    }
    if (code === 'plan_name_taken') {
        return (
            'Nothing was prepared. Ask the merchant for another name: `list_plans` returns ' +
            'the names in use.'
        );
    }
    if (status === 409) {
        return (
            'Nothing was prepared. The name gives a slug another plan answers to: ask the ' +
            'merchant for another name.'
        );
    }
    if (status === 403) {
        return (
            'Nothing was prepared. Relay that message to the merchant as it is: only they can ' +
            'delete a plan or change the tier, in the dashboard, and no tool here does either. ' +
            'If it is about retries, call again without `retry_attempts` and `retry_delay_minutes`.'
        );
    }
    return undefined;
}

/** What to check before preparing again a plan whose first try may have gone through. */
const PREPARED_ALREADY =
    ' Read `list_plans` before preparing it again: a plan of that name that is PENDING means ' +
    'this call went through.';

/**
 * What the agent can do about a refusal, from its `code`, its status and the
 * tool that was called, never from its message: wait and for how long,
 * correct the request, look the id up, connect again, hand the merchant what
 * only they can do, or stop.
 */
export function adviceFor(refusal: Refused, tool?: string): string {
    const { code, status, retryable, retryAfterSeconds } = refusal;
    const seconds = retryAfterSeconds === null ? null : `${retryAfterSeconds} seconds`;
    const preparing = tool === 'prepare_plan';

    if (status === 429) {
        return `Too many calls on this connection: wait ${seconds ?? 'a minute'}, then call again.`;
    }
    if (code === 'invalid_agent_token') {
        return 'The connection to Mesub expired or was revoked: connect again, then repeat the call.';
    }
    if (code === 'result_too_large' || code === 'prepared_plan_mismatch') return '';
    if (code === 'response_too_large') {
        return (
            'Ask for less: a narrower filter (one plan, one group, a search), a shorter ' +
            'window or a smaller `limit`.'
        );
    }
    if (code === 'unexpected') {
        return (
            'Nothing here says whether a change went through: read the current state before ' +
            `calling again.${preparing ? PREPARED_ALREADY : ''}`
        );
    }
    const prepare = preparing ? prepareAdvice(refusal) : undefined;
    if (prepare !== undefined) return prepare;

    if (status === 404) {
        return 'Nothing of this project has that id or slug: take it from the tool that lists them.';
    }
    if (status === 400) return 'Correct the request before calling again.';
    if (status === 403) {
        return 'Not allowed for this project as it stands: the same call gives the same answer.';
    }
    if (status === 409) {
        return 'Refused in the current state, and nothing was changed: read it again before deciding.';
    }
    if (status === null && code === 'unavailable') {
        return (
            'Temporary: call again in a moment. If the call was a change, read the current ' +
            `state first: it may have gone through.${preparing ? PREPARED_ALREADY : ''}`
        );
    }
    if (retryable) {
        return `Temporary: call again in ${seconds ?? 'a moment'}.${preparing ? PREPARED_ALREADY : ''}`;
    }
    return '';
}

/** A message of the API, ended: one that stops without punctuation would run into the advice. */
function ended(message: string): string {
    const said = message.trimEnd();
    return said === '' || /[.!?]["')\]]?$/.test(said) ? said : `${said}.`;
}

function refused(error: Refused, tool: string): CallToolResult {
    const advice = adviceFor(error, tool);
    return {
        isError: true,
        content: [
            {
                type: 'text',
                text: `Mesub error ${error.code}: ${ended(error.message)}${advice === '' ? '' : ` ${advice}`}`,
            },
        ],
        _meta: { [ERROR_META_KEY]: error },
    };
}

/**
 * A failed call, as a tool error the agent can read and act on: Mesub's own
 * `code` and `message`, what to do about it, and nothing else. Never a stack
 * trace, a header, a URL or the token: anything that is not a Mesub error is
 * logged here and answered with one fixed sentence.
 */
export function failure(error: unknown, tool: string, logger: Logger): CallToolResult {
    if (error instanceof ToolRefusal) {
        const { code, message } = error;
        return refused(
            { code, message, status: null, retryable: false, retryAfterSeconds: null },
            tool,
        );
    }

    if (error instanceof MesubApiError) {
        const { code, message, status, retryable, retryAfterSeconds, walletUrl } = error;

        if (code === 'invalid_service_credentials') {
            // OUR fault, and nothing the caller can do about it: never said to them.
            logger.error('tool call refused by Mesub', {
                tool,
                code,
                status,
                hint: 'MESUB_SERVICE_SECRET is not the one the Mesub API holds.',
            });
            return refused(
                {
                    code: 'unavailable',
                    message: 'The Mesub MCP server cannot reach the Mesub API right now.',
                    status: 503,
                    retryable: true,
                    retryAfterSeconds: 30,
                },
                tool,
            );
        }

        logger.info('tool call refused by Mesub', { tool, code, status });
        return refused(
            {
                code,
                message,
                status,
                retryable,
                retryAfterSeconds,
                // Only where it is acted on: no other refusal carries an address.
                ...(code === 'wallet_required' && { walletUrl }),
            },
            tool,
        );
    }

    logger.error('tool call failed', { tool, error });
    return refused(
        {
            code: 'internal_error',
            message: 'The Mesub MCP server failed to run this tool.',
            status: null,
            retryable: false,
            retryAfterSeconds: null,
        },
        tool,
    );
}
