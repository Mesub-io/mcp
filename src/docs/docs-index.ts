import * as z from 'zod';

import raw from './index.json';

/** Where the Mesub docs are served. A hit's URL is this, the page's path and its anchor. */
export const DOCS_BASE_URL = 'https://docs.mesub.io';

/**
 * src/docs/index.json, written by scripts/build-docs-index.mjs from one commit
 * of the docs repository and committed here: the server reads no docs at run
 * time, from the network or from disk.
 */
export const docsIndexSchema = z.object({
    version: z.literal(1),
    source: z.object({
        repository: z.string(),
        /** The commit of the docs the index was built from. */
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        /** When that commit was made. */
        committed_at: z.iso.datetime(),
    }),
    pages: z.array(
        z.object({
            /** `/docs/webhooks`: what follows the docs' base URL. */
            path: z.string().startsWith('/').max(200),
            title: z.string().max(200),
            sidebar_title: z.string().max(200),
            description: z.string(),
        }),
    ),
    sections: z.array(
        z.object({
            /** The position of its page in `pages`. */
            page: z.number().int().min(0),
            /** Empty for what a page says before its first heading. */
            heading: z.string().max(200),
            /** Null when the site has no anchor for it. */
            anchor: z.string().max(200).nullable(),
            /** Plain text, code blocks kept as written. */
            text: z.string(),
        }),
    ),
});
export type DocsIndex = z.infer<typeof docsIndexSchema>;
export type DocsPage = DocsIndex['pages'][number];
export type DocsSection = DocsIndex['sections'][number];

/** The index this build of the server carries. Parsed once, when the process starts. */
export const DOCS_INDEX: DocsIndex = docsIndexSchema.parse(raw);
