import type {
    CallToolResult,
    McpServer,
    ServerContext,
    ToolCallback,
} from '@modelcontextprotocol/server';
import type * as z from 'zod';

import { addressOf, callerOf, loggableName, markTokenRefused } from '../auth.js';
import type { Logger } from '../logger.js';
import type { MesubClient } from '../mesub/client.js';
import { MesubApiError } from '../mesub/errors.js';
import { checkAccess } from './check-access.js';
import { createWebhook } from './create-webhook.js';
import { deleteWebhook } from './delete-webhook.js';
import { getOverview } from './get-overview.js';
import { getPlan } from './get-plan.js';
import { getProject } from './get-project.js';
import { getSubscription } from './get-subscription.js';
import { getWebhookSecret } from './get-webhook-secret.js';
import { listEvents } from './list-events.js';
import { listPlans } from './list-plans.js';
import { listSubscriptions } from './list-subscriptions.js';
import { listUpcomingCharges } from './list-upcoming-charges.js';
import { listWebhookDeliveries } from './list-webhook-deliveries.js';
import { HARD_RESULT_LENGTH } from './limits.js';
import { listWebhooks } from './list-webhooks.js';
import { ping } from './ping.js';
import { regenerateWebhookSecret } from './regenerate-webhook-secret.js';
import { failure, success, ToolRefusal } from './result.js';
import { retryCharge } from './retry-charge.js';
import { searchDocs } from './search-docs.js';
import { sendTestWebhook } from './send-test-webhook.js';
import { updateProject } from './update-project.js';
import { updateRetryPolicy } from './update-retry-policy.js';
import { updateWebhook } from './update-webhook.js';
import type { ToolDefinition } from './tool.js';

export interface ToolDependencies {
    logger: Logger;
    /** The Mesub API as the caller holding this token. */
    mesubFor: (token: string) => MesubClient;
}

/** A tool, whatever its schemas. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, any>;

/**
 * Every tool this server has, in the order `tools/list` gives them. A new
 * tool is one file next to this one and one line here.
 */
export const TOOLS: readonly AnyTool[] = [
    ping,
    searchDocs,
    // What reads the project.
    getProject,
    listPlans,
    getPlan,
    listSubscriptions,
    getSubscription,
    checkAccess,
    listEvents,
    listUpcomingCharges,
    getOverview,
    listWebhooks,
    listWebhookDeliveries,
    // What changes it.
    updateProject,
    updateRetryPolicy,
    retryCharge,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    getWebhookSecret,
    regenerateWebhookSecret,
    sendTestWebhook,
];

export function registerTools(
    server: McpServer,
    dependencies: ToolDependencies,
    tools: readonly AnyTool[] = TOOLS,
): void {
    for (const tool of tools) register(server, tool, dependencies);
}

function register<Input extends z.ZodObject, Output extends z.ZodObject>(
    server: McpServer,
    tool: ToolDefinition<Input, Output>,
    { logger, mesubFor }: ToolDependencies,
): void {
    const { name, title, description, inputSchema, outputSchema, annotations } = tool;

    const call = async (args: unknown, context: ServerContext): Promise<CallToolResult> => {
        // Set by the auth seam (src/auth.ts) for every request let through.
        const authInfo = context.http?.authInfo;
        const caller = callerOf(authInfo);
        const started = performance.now();
        let outcome = 'ok';
        try {
            if (authInfo === undefined || caller === undefined) {
                throw new MesubApiError('This call carries no access token.', {
                    status: 401,
                    code: 'unauthorized',
                    retryable: false,
                });
            }

            // The SDK has validated the arguments against the input schema.
            // The token stops here: a tool gets who it stands for, and a client
            // that carries it, never the token itself.
            const { data, text } = await tool.handler(args as z.output<Input>, {
                caller,
                mesub: mesubFor(authInfo.token),
                signal: context.mcpReq.signal,
            });
            // Parsed on the way out too: a field the schema does not name never leaves.
            const result = success(outputSchema.parse(data), text);
            // Every list is capped and every text cut already: this is the net under them.
            if (JSON.stringify(result.structuredContent).length > HARD_RESULT_LENGTH) {
                throw new ToolRefusal(
                    'result_too_large',
                    'The result is too long to return. Ask for less: a smaller `limit`, or a narrower filter.',
                );
            }
            return result;
        } catch (error) {
            outcome =
                error instanceof MesubApiError || error instanceof ToolRefusal
                    ? error.code
                    : 'internal_error';
            // The API took the token a moment ago and refuses it now: revoked or
            // expired in between. Said to the seam, which answers as it does a dead token.
            if (error instanceof MesubApiError && error.code === 'invalid_agent_token') {
                markTokenRefused(authInfo);
            }
            return failure(error, name, logger);
        } finally {
            // The trace a token leaves: who called what, from where, and how it
            // ended. Never an argument nor a result, which are the merchant's.
            logger.info('tool call', {
                tool: name,
                outcome,
                durationMs: Math.round(performance.now() - started),
                connectionId: caller?.connectionId ?? null,
                projectId: caller?.projectId ?? null,
                clientName: caller ? loggableName(caller.clientName) : null,
                address: addressOf(authInfo),
            });
        }
    };

    server.registerTool(
        name,
        { title, description, inputSchema, outputSchema, annotations },
        // The SDK cannot infer the arguments' type through this function's generics.
        call as ToolCallback<Input>,
    );
}
