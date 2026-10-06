import type * as z from 'zod';

import type { MesubClient } from '../mesub/client.js';

/**
 * All four hints, on every tool: a client decides from them whether to ask
 * its user first, and the defaults of a hint left out are the alarming ones.
 */
export interface ToolAnnotations {
    /** The tool changes nothing. */
    readOnlyHint: boolean;
    /** The tool may delete or overwrite. Meaningless when read-only: false then. */
    destructiveHint: boolean;
    /** Calling it twice with the same arguments does no more than once. */
    idempotentHint: boolean;
    /** The tool reaches beyond the Mesub project: the chain, a merchant's endpoint. */
    openWorldHint: boolean;
}

/** What a handler gets besides its arguments. */
export interface ToolContext {
    /** The caller's access token, passed through to Mesub. Never log it. */
    token: string;
    /** The Mesub API as this caller. */
    mesub: MesubClient;
    /** Aborted when the caller cancels or disconnects. */
    signal: AbortSignal;
}

/** What a handler returns: the data, and one short sentence about it. */
export interface ToolOutput<Data> {
    data: Data;
    text: string;
}

export interface ToolDefinition<Input extends z.ZodObject, Output extends z.ZodObject> {
    /** snake_case, verb first: `list_plans`, `retry_charge`. */
    name: string;
    /** A few words, for a person reading a list of tools. */
    title: string;
    /** For the agent choosing a tool: what it does, when to use it, what it returns. */
    description: string;
    /** `z.strictObject`: an argument the tool does not take is refused, not dropped. */
    inputSchema: Input;
    outputSchema: Output;
    annotations: ToolAnnotations;
    /** One or a few calls to the Mesub API. A `MesubApiError` is left to be thrown. */
    handler: (args: z.output<Input>, context: ToolContext) => Promise<ToolOutput<z.input<Output>>>;
}

/** Types a tool's handler from its schemas. */
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
    tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
    return tool;
}
