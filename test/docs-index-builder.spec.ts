import { fileURLToPath } from 'node:url';

import {
    buildDocsIndex,
    parseFrontmatter,
    parseJsonc,
    serializeIndex,
    Slugger,
} from '../scripts/build-docs-index.mjs';
import { docsIndexSchema } from '../src/docs/docs-index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/docs', import.meta.url));
const SOURCE = {
    commit: '0123456789abcdef0123456789abcdef01234567',
    committed_at: '2026-10-01T12:00:00.000Z',
};

describe('the docs index builder, on a small docs tree', () => {
    const index = buildDocsIndex(FIXTURE, SOURCE);
    const page = (path: string) => index.pages.findIndex((entry) => entry.path === path);
    const sections = (path: string) =>
        index.sections.filter((section) => section.page === page(path));
    const section = (path: string, anchor: string | null, heading?: string) => {
        const found = sections(path).find(
            (entry) =>
                entry.anchor === anchor && (heading === undefined || entry.heading === heading),
        );
        if (!found) throw new Error(`no section ${String(anchor)} in ${path}`);
        return found;
    };

    it('records the docs commit it was built from, and nothing of when it ran', () => {
        expect(index.source).toEqual({ repository: 'Mesub-io/docs', ...SOURCE });
        expect(serializeIndex(buildDocsIndex(FIXTURE, SOURCE))).toBe(serializeIndex(index));
    });

    it('is what the server reads', () => {
        expect(() => docsIndexSchema.parse(JSON.parse(serializeIndex(index)))).not.toThrow();
    });

    it('takes the pages of the navigation, in its order, and no other file', () => {
        expect(index.pages.map((entry) => entry.path)).toEqual([
            '/',
            '/docs/guide',
            '/reference/things/check',
        ]);
        expect(JSON.stringify(index)).not.toContain('not published');
    });

    it('reads the frontmatter, and not what a block of it quotes', () => {
        expect(index.pages[page('/docs/guide')]).toEqual({
            path: '/docs/guide',
            title: 'Handle webhooks on your server',
            sidebar_title: 'Webhooks',
            description: 'Register an endpoint, then verify each delivery.',
        });
    });

    it('splits a page into sections by heading, the opening first', () => {
        expect(sections('/docs/guide').map((entry) => [entry.heading, entry.anchor])).toEqual([
            ['', null],
            ['Usage', 'usage'],
            ['Events', 'events'],
            ['Usage', 'usage-1'],
            ["At a plan's end", 'at-a-plans-end'],
            ['A custom anchor', 'my-id'],
        ]);
    });

    it('reads a heading written as JSX', () => {
        expect(sections('/').map((entry) => [entry.heading, entry.anchor])).toEqual([
            ['', null],
            [
                'Recurring payments, billed from your server',
                'recurring-payments-billed-from-your-server',
            ],
        ]);
    });

    it('opens a page with its description, then its text as plain text', () => {
        expect(section('/docs/guide', null).text).toBe(
            [
                'Register an endpoint, then verify each delivery.',
                '`hasAccess` is enough to gate a route. Webhooks are for reacting when ' +
                    'something changes: see the lifecycle and `Bearer <API key>`.',
            ].join('\n'),
        );
    });

    it('strips imports and components, keeping the title a component carries', () => {
        const text = JSON.stringify(index);
        expect(text).not.toMatch(/components\/lifecycle|<Lifecycle|<CodeGroup|<Columns|<Card/);
        expect(text).not.toMatch(/lucide|href=|fontSize/);
        expect(section('/', 'recurring-payments-billed-from-your-server').text).toBe(
            [
                'The home page says hello.',
                'Your first subscriber:',
                'A plan, an API key and a button.',
            ].join('\n'),
        );
        expect(section('/docs/guide', 'events').text).toContain('See a full event:');
    });

    it('keeps a code block as it is written, whatever it looks like', () => {
        expect(section('/docs/guide', 'usage').text).toBe(
            [
                'Put the signing secret in your environment:',
                '```bash',
                'MESUB_WEBHOOK_SECRET=whsec_...',
                '```',
                '```ts Express',
                "import express from 'express';",
                '## not a heading',
                'const page = <Tag>kept</Tag>;',
                'export const handler = async () => mesub.webhooks.verify(body, headers);',
                '```',
            ].join('\n'),
        );
    });

    it('keeps the rows of a table, without its ruler', () => {
        const { text } = section('/docs/guide', 'events');
        expect(text).toContain('Event | Sent when');
        expect(text).toContain('`subscription.renewal_upcoming` | A renewal is near');
        expect(text).toContain('`subscription.ended` | It is over, `plan_ended`');
        expect(text).not.toContain('---');
    });

    it('joins the lines of a paragraph and of a list item', () => {
        expect(section('/docs/guide', 'usage-1').text).toBe(
            [
                '1. Open the dashboard and copy the URL.',
                '2. Click Send test.',
                '- A first point',
                '- A second point',
            ].join('\n'),
        );
    });

    describe('a reference page', () => {
        const path = '/reference/things/check';

        it('opens with the route, its limit and its examples', () => {
            const { text } = section(path, null);
            expect(text.split('\n').slice(0, 2)).toEqual([
                '`GET /v1/things/{id}`',
                'Limit: 100 calls a minute per API key.',
            ]);
            expect(text).toContain('```bash cURL');
            expect(text).toContain('-H "Authorization: Bearer $MESUB_API_KEY"');
            // The description repeats the page's first sentence: said once.
            expect(text.match(/Whether a thing is there/g)).toHaveLength(1);
        });

        it('draws its parameters and answers from the OpenAPI document', () => {
            expect(sections(path).map((entry) => [entry.heading, entry.anchor])).toEqual([
                ['', null],
                ['Path parameters', null],
                ['Query parameters', null],
                ['Responses', null],
            ]);
            expect(section(path, null, 'Path parameters').text).toBe("`id`: The thing's id.");
            expect(section(path, null, 'Query parameters').text).toBe(
                '`expand`: What to add to the answer, see the guide. One of `owner`, `history`.',
            );
            expect(section(path, null, 'Responses').text).toBe(
                [
                    '`200`: The thing.',
                    "`id`: The thing's id.",
                    '`owner`: Who holds the thing.',
                    "`detail`: The thing's own fields.",
                    '`detail.can_pay`: Whether it can pay.',
                    '`404`: No such thing.',
                    '`thing_not_found`: No thing under that id.',
                    '`thing_busy`: It is being changed. Retryable.',
                ].join('\n'),
            );
        });

        it('does not unfold an object named elsewhere inside another', () => {
            expect(JSON.stringify(index)).not.toContain('secret_name');
        });
    });

    it('refuses a page of the navigation that has no file', () => {
        expect(() => buildDocsIndex(FIXTURE, SOURCE, { pages: ['index', 'docs/missing'] })).toThrow(
            /docs\/missing/,
        );
    });
});

describe('Slugger', () => {
    it('slugs a heading the way the docs site does', () => {
        const slugger = new Slugger();
        expect(slugger.slug("At a plan's end")).toBe('at-a-plans-end');
        expect(slugger.slug('A guard, end to end')).toBe('a-guard-end-to-end');
        expect(slugger.slug('When Mesub does not answer')).toBe('when-mesub-does-not-answer');
        expect(slugger.slug('subscription.renewal_upcoming')).toBe('subscriptionrenewal_upcoming');
        expect(slugger.slug('Read an attempt')).toBe('read-an-attempt');
    });

    it('numbers a heading said twice', () => {
        const slugger = new Slugger();
        expect([slugger.slug('Usage'), slugger.slug('Usage'), slugger.slug('usage')]).toEqual([
            'usage',
            'usage-1',
            'usage-2',
        ]);
    });
});

describe('parseFrontmatter', () => {
    it('reads quoted and bare values, and skips a block', () => {
        const { data, body } = parseFrontmatter(
            [
                '---',
                'title: "Check a customer\'s \\"access\\""',
                'sidebarTitle: Check access',
                "description: 'It''s here'",
                'prompt: |',
                '  title: "no"',
                '---',
                '',
                'Body.',
            ].join('\n'),
        );
        expect(data).toMatchObject({
            title: 'Check a customer\'s "access"',
            sidebarTitle: 'Check access',
            description: "It's here",
        });
        expect(data).not.toHaveProperty('prompt');
        expect(body.trim()).toBe('Body.');
    });

    it('takes a page without one as all body', () => {
        expect(parseFrontmatter('Just text.')).toEqual({ data: {}, body: 'Just text.' });
    });
});

describe('parseJsonc', () => {
    it('drops comments and trailing commas, and nothing inside a string', () => {
        expect(parseJsonc('{ // one\n "a": "http://x/*y*/", /* two */ "b": [1, 2,], }')).toEqual({
            a: 'http://x/*y*/',
            b: [1, 2],
        });
    });
});
