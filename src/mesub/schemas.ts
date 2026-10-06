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
