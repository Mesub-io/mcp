import type {
    CallToolResult,
    McpServer,
    ServerContext,
    ToolCallback,
} from '@modelcontextprotocol/server';
import type * as z from 'zod';

import type { Logger } from '../logger.js';
import type { MesubClient } from '../mesub/client.js';
import { MesubApiError } from '../mesub/errors.js';
import { ping } from './ping.js';
import { failure, success } from './result.js';
import type { ToolDefinition } from './tool.js';

export interface ToolDependencies {
    logger: Logger;
    /** The Mesub API as the caller holding this token. */
    mesubFor: (token: string) => MesubClient;
}

/**
 * Every tool this server has, in the order `tools/list` gives them. A new
 * tool is one file next to this one and one line here.
 */
export function registerTools(server: McpServer, dependencies: ToolDependencies): void {
    register(server, ping, dependencies);
}

function register<Input extends z.ZodObject, Output extends z.ZodObject>(
    server: McpServer,
    tool: ToolDefinition<Input, Output>,
    { logger, mesubFor }: ToolDependencies,
): void {
    const { name, title, description, inputSchema, outputSchema, annotations } = tool;

    const call = async (args: unknown, context: ServerContext): Promise<CallToolResult> => {
        try {
            // Set by the auth seam (src/auth.ts) for every request let through.
            const token = context.http?.authInfo?.token;
            if (token === undefined) {
                throw new MesubApiError('This call carries no access token.', {
                    status: 401,
                    code: 'unauthorized',
                    retryable: false,
                });
            }

            // The SDK has validated the arguments against the input schema.
            const { data, text } = await tool.handler(args as z.output<Input>, {
                token,
                mesub: mesubFor(token),
                signal: context.mcpReq.signal,
            });
            // Parsed on the way out too: a field the schema does not name never leaves.
            return success(outputSchema.parse(data), text);
        } catch (error) {
            return failure(error, name, logger);
        }
    };

    server.registerTool(
        name,
        { title, description, inputSchema, outputSchema, annotations },
        // The SDK cannot infer the arguments' type through this function's generics.
        call as ToolCallback<Input>,
    );
}
