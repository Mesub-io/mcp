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

/**
 * A failed call, as a tool error the agent can read and act on: Mesub's own
 * `code` and `message`, and nothing else. Never a stack trace, a header, a
 * URL or the token: anything that is not a Mesub error is logged here and
 * answered with one fixed sentence.
 */
export function failure(error: unknown, tool: string, logger: Logger): CallToolResult {
    if (error instanceof MesubApiError) {
        const { code, message, status, retryable, retryAfterSeconds } = error;
        logger.info('tool call refused by Mesub', { tool, code, status });
        return {
            isError: true,
            content: [{ type: 'text', text: `Mesub error ${code}: ${message}` }],
            _meta: { [ERROR_META_KEY]: { code, message, status, retryable, retryAfterSeconds } },
        };
    }

    logger.error('tool call failed', { tool, error });
    const code = 'internal_error';
    const message = 'The Mesub MCP server failed to run this tool.';
    return {
        isError: true,
        content: [{ type: 'text', text: `Mesub error ${code}: ${message}` }],
        _meta: {
            [ERROR_META_KEY]: {
                code,
                message,
                status: null,
                retryable: false,
                retryAfterSeconds: null,
            },
        },
    };
}
