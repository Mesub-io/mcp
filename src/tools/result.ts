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
}

/**
 * What the agent can do about a refusal, from its `code` and its status and
 * never from its message: wait and for how long, correct the request, look
 * the id up, connect again, or stop.
 */
export function adviceFor({ code, status, retryable, retryAfterSeconds }: Refused): string {
    const seconds = retryAfterSeconds === null ? null : `${retryAfterSeconds} seconds`;

    if (code === 'agent_write_cap_reached') {
        return (
            'This connection made too many changes this hour: none goes through for ' +
            `${seconds ?? 'a while'}. Reading still works.`
        );
    }
    if (status === 429) {
        return `Too many calls on this connection: wait ${seconds ?? 'a minute'}, then call again.`;
    }
    if (code === 'invalid_agent_token') {
        return 'The connection to Mesub expired or was revoked: connect again, then repeat the call.';
    }
    if (code === 'result_too_large') return '';
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
            'state first: it may have gone through.'
        );
    }
    if (retryable) return `Temporary: call again in ${seconds ?? 'a moment'}.`;
    return '';
}

function refused(error: Refused): CallToolResult {
    const advice = adviceFor(error);
    return {
        isError: true,
        content: [
            {
                type: 'text',
                text: `Mesub error ${error.code}: ${error.message}${advice === '' ? '' : ` ${advice}`}`,
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
        return refused({ code, message, status: null, retryable: false, retryAfterSeconds: null });
    }

    if (error instanceof MesubApiError) {
        const { code, message, status, retryable, retryAfterSeconds } = error;

        if (code === 'invalid_service_credentials') {
            // OUR fault, and nothing the caller can do about it: never said to them.
            logger.error('tool call refused by Mesub', {
                tool,
                code,
                status,
                hint: 'MESUB_SERVICE_SECRET is not the one the Mesub API holds.',
            });
            return refused({
                code: 'unavailable',
                message: 'The Mesub MCP server cannot reach the Mesub API right now.',
                status: 503,
                retryable: true,
                retryAfterSeconds: 30,
            });
        }

        logger.info('tool call refused by Mesub', { tool, code, status });
        return refused({ code, message, status, retryable, retryAfterSeconds });
    }

    logger.error('tool call failed', { tool, error });
    return refused({
        code: 'internal_error',
        message: 'The Mesub MCP server failed to run this tool.',
        status: null,
        retryable: false,
        retryAfterSeconds: null,
    });
}
