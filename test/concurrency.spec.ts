import type { Client } from '@modelcontextprotocol/client';
import * as z from 'zod';

import { defineTool } from '../src/tools/tool.js';
import { bearer, callTool, connect, fakeMesubApi, readJsonRpc, startServer } from './helpers.js';

/** Says who it was called as, twice: by what it was handed, and by what the API answers its client. */
const who = defineTool({
    name: 'who',
    title: 'Who',
    description: 'Returns the connection and the project the call was made for.',
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
        connection_id: z.string(),
        project_id: z.string(),
        via_api: z.string(),
    }),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
    handler: async (_args, { caller, mesub }) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
        const seen = await mesub.whoami();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
        return {
            data: {
                connection_id: caller.connectionId,
                project_id: caller.projectId,
                via_api: seen.connection_id,
            },
            text: 'ok',
        };
    },
});

describe('two callers at once', () => {
    it('hands each of 400 interleaved calls its own caller, on both generations of client', async () => {
        const api = await fakeMesubApi();
        api.issue('mat_alice', {
            connection_id: 'ALICE',
            project: { id: 'proj_alice', name: 'A' },
        });
        api.issue('mat_bob', { connection_id: 'BOB', project: { id: 'proj_bob', name: 'B' } });
        api.delayWhoami(3);
        const server = await startServer(
            { MESUB_API_URL: api.url },
            { tools: [who], limits: { perConnection: 100_000 } },
        );

        const expected = {
            ALICE: { connection_id: 'ALICE', project_id: 'proj_alice', via_api: 'ALICE' },
            BOB: { connection_id: 'BOB', project_id: 'proj_bob', via_api: 'BOB' },
        };
        const raw = async (token: string) => {
            const response = await callTool(server.url, 'who', {}, bearer(token));
            const body = (await readJsonRpc(response)) as {
                result?: { structuredContent?: unknown };
            };
            return body.result?.structuredContent;
        };
        const modern = async (client: Client) =>
            (await client.callTool({ name: 'who', arguments: {} })).structuredContent;

        const alice = await connect(server.url, { token: 'mat_alice', modern: true });
        const bob = await connect(server.url, { token: 'mat_bob', modern: true });

        const calls: Promise<[unknown, unknown]>[] = [];
        for (let i = 0; i < 100; i++) {
            calls.push(
                raw('mat_alice').then((seen) => [seen, expected.ALICE]),
                raw('mat_bob').then((seen) => [seen, expected.BOB]),
                modern(alice).then((seen) => [seen, expected.ALICE]),
                modern(bob).then((seen) => [seen, expected.BOB]),
            );
        }
        const results = await Promise.all(calls);

        expect(results).toHaveLength(400);
        for (const [seen, wanted] of results) expect(seen).toEqual(wanted);

        await alice.close();
        await bob.close();
        await server.stop();
        await api.close();
    }, 30_000);
});
