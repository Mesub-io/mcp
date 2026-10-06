import type {
    CallToolResult,
    McpServer,
    ServerContext,
    ToolCallback,
} from '@modelcontextprotocol/server';
import type * as z from 'zod';

import { callerOf } from '../auth.js';
import type { Logger } from '../logger.js';
import type { MesubClient } from '../mesub/client.js';
import { MesubApiError } from '../mesub/errors.js';
import { ping } from './ping.js';
import { failure, success } from './result.js';
import { searchDocs } from './search-docs.js';
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
export const TOOLS: readonly AnyTool[] = [ping, searchDocs];

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
        try {
            // Set by the auth seam (src/auth.ts) for every request let through.
            const authInfo = context.http?.authInfo;
            const caller = callerOf(authInfo);
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
