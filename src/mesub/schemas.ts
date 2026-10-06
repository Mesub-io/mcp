import * as z from 'zod';

// What the tools read from the Mesub API, one schema per answer. An answer is
// parsed against its schema before a tool sees it: unknown fields are dropped.

/** `GET /health`. */
export const apiHealthSchema = z.object({
    status: z.string(),
    /** Seconds since the API process started. */
    uptime: z.number(),
});
export type ApiHealth = z.infer<typeof apiHealthSchema>;

/** `GET /agent/whoami`: the connection an agent's access token stands for. */
export const agentWhoamiSchema = z.object({
    connection_id: z.string().min(1).max(200),
    project: z.object({ id: z.string().min(1).max(200), name: z.string().max(500) }),
    client: z.object({ id: z.string().max(2048), name: z.string().max(500) }),
    scope: z.string().max(500),
    /** Who the token is for: this server's own resource URL, which it checks. */
    audience: z.string().max(2048),
    issuer: z.string().max(2048),
    /** When the access token stops working, in seconds since the epoch. */
    expires_at: z
        .number()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / 1000),
});
export type AgentWhoami = z.infer<typeof agentWhoamiSchema>;
