import { callTool, connect, fakeMesubApi, startServer } from './helpers.js';

describe('stop', () => {
    it('stops listening, and can be asked twice', async () => {
        const server = await startServer();
        expect((await fetch(`${server.url}/health`)).status).toBe(200);

        await Promise.all([server.stop(), server.stop()]);

        await expect(fetch(`${server.url}/health`)).rejects.toThrow();
    });

    it('lets a tool call already running end', async () => {
        const api = await fakeMesubApi();
        const server = await startServer({ MESUB_API_URL: api.url });
        const client = await connect(server.url, { modern: true });

        const release = api.hold();
        const running = client.callTool({ name: 'ping', arguments: {} });
        await vi.waitFor(() => expect(api.callsTo('/health')).toHaveLength(1));

        let stopped = false;
        const stopping = server.stop().then(() => {
            stopped = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(stopped).toBe(false);

        release();
        expect((await running).structuredContent).toEqual({ status: 'ok', uptime_seconds: 42 });
        await stopping;
        expect(stopped).toBe(true);

        await client.close();
        await api.close();
    });

    it('lets a check of a token already running end', async () => {
        const api = await fakeMesubApi();
        const server = await startServer({ MESUB_API_URL: api.url });

        const release = api.holdWhoami();
        const running = callTool(server.url, 'ping');
        await vi.waitFor(() => expect(api.callsTo('/agent/whoami')).toHaveLength(1));

        const stopping = server.stop();
        release();
        expect((await running).status).toBe(200);
        await stopping;
        await api.close();
    });
});
