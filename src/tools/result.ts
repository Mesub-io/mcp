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
    /** Where a merchant connects a wallet, or the Owner sets the team wallet: checked by the client. */
    walletUrl?: string | null;
    /** The id Mesub gave the request (`Mesub-Request-Id`), checked to be one. */
    requestId?: string | null;
}

/** What only the merchant can do about a plan that was not prepared, and what the agent can. */
function prepareAdvice({ code, status, walletUrl }: Refused): string | undefined {
    if (code === 'wallet_required') {
        // The address stands alone, so that nothing after it is read as part of it.
        const where = walletUrl ? `at ${walletUrl} ,` : 'in the settings of the Mesub dashboard,';
        return `Nothing was prepared. Ask the merchant to connect their wallet ${where} then call again.`;
    }
    if (code === 'team_wallet_required') {
        // The address stands alone, as above.
        const where = walletUrl
            ? `at ${walletUrl} ,`
            : 'in the Organization settings of the Mesub dashboard,';
        return (
            'Nothing was prepared. This organization has no team wallet yet, and only its ' +
            `Owner sets one, ${where} then call again.`
        );
    }
    if (code === 'end_date_too_soon') {
        return (
            'Nothing was prepared. The end is less than one period of the plan and five ' +
            'minutes away: ask the ' +
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
    // A bare 409 of the API: its slug check. Any other 409 code gets the advice by status.
    if (code === 'conflict') {
        return (
            'Nothing was prepared. The name gives a slug another plan answers to: ask the ' +
            'merchant for another name.'
        );
    }
    // By its code: a call that sent retries can still be refused for the plan cap.
    if (code === 'retries_not_on_tier') {
        return (
            "Nothing was prepared. The project's tier takes no retry policy: call again " +
            'without `retry_attempts` and `retry_delay_minutes` if the merchant agrees, ' +
            'telling them failed charges then wait for a retry by hand.'
        );
    }
    if (status === 403) {
        return (
            'Nothing was prepared. Relay that message to the merchant as it is: only they can ' +
            'delete a plan or change the tier, in the dashboard, and no tool here does either.'
        );
    }
    return undefined;
}

/** What a refused retry by hand leaves to do: nothing here, as long as the cause lasts. */
function retryAdvice({ code }: Refused): string | undefined {
    if (code === 'retry_cannot_succeed') {
        return (
            'Nothing was charged and no retry was spent: no retry can succeed while this ' +
            'lasts. Tell the merchant why, as the message says, and do not call `retry_charge` ' +
            'on this subscription again. A revoked approval or a closed authority is fixed ' +
            'only by the subscriber, subscribing again.'
        );
    }
    if (code === 'insufficient_balance') {
        return (
            'Nothing was charged and no retry was spent: the wallet holds less than the ' +
            'period, as the message says. A retry can succeed only once the subscriber adds ' +
            'funds: tell the merchant, and do not call again before.'
        );
    }
    return undefined;
}

/**
 * A member whose role does not allow the call: the message names who may.
 * Nothing the agent can do about it, and connecting again changes nothing.
 */
export const ROLE_ADVICE =
    "Nothing was changed. The merchant's role in this organization does not allow this: relay " +
    'the message as it is. Someone it names can do it, or can give them that role. The same ' +
    'call gives the same answer until then.';

/** Which project a call is for, when the connection reaches more than one. */
const PROJECT_ADVICE: Record<string, string> = {
    project_required:
        'Call `list_projects`, ask the merchant which project when it is not clear, then call ' +
        'again with `project`.',
    project_not_found: 'Take the project from `list_projects`: its id or its exact name.',
    project_ambiguous: "Call again with the project's id from `list_projects`.",
    project_outside_pin:
        'This connection reaches one project. For another, the merchant connects again and ' +
        'chooses the whole organization or that project.',
};

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
        const wait = `wait ${seconds ?? 'a minute'}, then call again.`;
        return tool === 'send_test_webhook'
            ? `Mesub takes at most ${TEST_DELIVERIES_A_MINUTE} test sends a minute on one ` +
                  `connection, refused ones included: ${wait}`
            : `Too many calls on this connection: ${wait}`;
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
    // Before what a tool or a status says: the same answer from every tool.
    if (code === 'role_required') return ROLE_ADVICE;
    const project = Object.hasOwn(PROJECT_ADVICE, code) ? PROJECT_ADVICE[code] : undefined;
    if (project !== undefined) return project;

    const prepare = preparing ? prepareAdvice(refusal) : undefined;
    if (prepare !== undefined) return prepare;
    const retry = tool === 'retry_charge' ? retryAdvice(refusal) : undefined;
    if (retry !== undefined) return retry;
    if (tool === 'update_retry_policy' && code === 'retries_not_on_tier') {
        return (
            "Nothing was changed. The project's tier takes no retry policy: only the merchant " +
            'can move the project up, in the dashboard, and no tool here does it.'
        );
    }

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

/** Test deliveries the Mesub API sends for one connection in a minute. */
export const TEST_DELIVERIES_A_MINUTE = 5;

/** The fields of the API a message may name, as the tools name them. */
const TOOL_FIELDS: Record<string, string> = {
    endsAt: 'ends_at',
    periodHours: 'period_hours',
    retryAttempts: 'retry_attempts',
    retryDelayMinutes: 'retry_delay_minutes',
    websiteUrl: 'website_url',
};

/**
 * A message of the API in the words of the tools: a field by the name the
 * agent sends it under, and no framework's name for a refusal.
 */
export function inToolWords(message: string): string {
    return message
        .replace(/^ThrottlerException:\s*Too Many Requests\.?$/i, 'Too many requests.')
        .replace(
            /\b(endsAt|periodHours|retryAttempts|retryDelayMinutes|websiteUrl)\b/g,
            (field) => TOOL_FIELDS[field] ?? field,
        );
}

/** A message of the API, ended: one that stops without punctuation would run into the advice. */
function ended(message: string): string {
    const said = message.trimEnd();
    return said === '' || /[.!?]["')\]]?$/.test(said) ? said : `${said}.`;
}

function refused(error: Refused, tool: string): CallToolResult {
    const advice = adviceFor(error, tool);
    // Checked to be `req_` and 24 letters or digits: never a text to relay.
    const support = error.requestId
        ? ` Mesub request id ${error.requestId}: quote it to Mesub support if the merchant asks them about this call.`
        : '';
    return {
        isError: true,
        content: [
            {
                type: 'text',
                text: `Mesub error ${error.code}: ${ended(inToolWords(error.message))}${advice === '' ? '' : ` ${advice}`}${support}`,
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
        const { code, message, status, retryable, retryAfterSeconds, walletUrl, requestId } = error;

        if (code === 'invalid_service_credentials') {
            // OUR fault, and nothing the caller can do about it: never said to them.
            logger.error('tool call refused by Mesub', {
                tool,
                code,
                status,
                requestId,
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

        logger.info('tool call refused by Mesub', { tool, code, status, requestId });
        return refused(
            {
                code,
                message,
                status,
                retryable,
                retryAfterSeconds,
                ...(requestId !== null && { requestId }),
                // Only where it is acted on: no other refusal carries an address.
                ...((code === 'wallet_required' || code === 'team_wallet_required') && {
                    walletUrl,
                }),
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
