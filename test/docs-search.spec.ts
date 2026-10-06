import { DOCS_BASE_URL, DOCS_INDEX, type DocsIndex } from '../src/docs/docs-index.js';
import {
    DocsSearch,
    editDistance,
    MAX_PASSAGE_LENGTH,
    passage,
    stem,
    tokenize,
} from '../src/docs/search.js';

const terms = (text: string) => tokenize(text).map((token) => token.term);

describe('tokenize', () => {
    it('gives a plain word as its stem', () => {
        expect(terms('Webhooks are retried')).toEqual(['webhook', 'are', 'retry']);
    });

    it.each([
        ['hasAccess', ['hasaccess', 'has', 'access']],
        ['plan_ended', ['plan_ended', 'plan', 'end']],
        ['MESUB_API_KEY', ['mesub_api_key', 'mesub', 'api', 'key']],
        ['webhook-signature', ['webhook-signature', 'webhook', 'signatur']],
        [
            'subscription.renewal_upcoming',
            ['subscription.renewal_upcoming', 'renewal_upcoming', 'subscript', 'renewal', 'upcom'],
        ],
        [
            'mesub.webhooks.verify',
            ['mesub.webhooks.verify', 'webhooks.verify', 'mesub', 'webhook', 'verify'],
        ],
    ])('gives the identifier %s whole, then its words', (identifier, expected) => {
        expect(terms(identifier)).toEqual(expected);
    });

    it('ends a sentence without taking its full stop for a dot', () => {
        expect(terms('It ends. Then')).toEqual(['it', 'end', 'then']);
    });
});

describe('stem', () => {
    it.each([
        ['ends', 'ended', 'ending'],
        ['pay', 'pays', 'paying'],
        ['cancel', 'cancelled', 'cancelling'],
        ['stop', 'stopped', 'stops'],
        ['verify', 'verifies', 'verified'],
        ['retry', 'retries', 'retried'],
        ['subscribe', 'subscribed', 'subscribing'],
        ['integrate', 'integration', 'integrations'],
        ['signature', 'signatures', 'signature'],
    ])('reads %s, %s and %s as one word', (...forms) => {
        expect(new Set(forms.map(stem)).size).toBe(1);
    });

    it.each(['access', 'status', 'this', 'has'])('leaves %s alone', (word) => {
        expect(stem(word)).toBe(word);
    });
});

describe('editDistance', () => {
    it.each([
        ['webhook', 'webhook', 0],
        ['webhok', 'webhook', 1],
        ['hasacess', 'hasaccess', 1],
        ['wehbook', 'webhook', 1],
        ['renewal_upcomming', 'renewal_upcoming', 1],
        ['kubernetes', 'webhook', 3],
    ])('counts %s to %s as %i, stopping past 2', (a, b, distance) => {
        expect(editDistance(a, b, 2)).toBe(distance);
    });
});

/** A small index, to say what the scoring does without the real docs moving under it. */
function indexOf(sections: [page: string, heading: string, text: string][]): DocsIndex {
    const titles = [...new Set(sections.map(([page]) => page))];
    return {
        version: 1,
        source: {
            repository: 'Mesub-io/docs',
            commit: 'a'.repeat(40),
            committed_at: '2026-10-01T00:00:00.000Z',
        },
        pages: titles.map((title) => ({
            path: `/docs/${title.toLowerCase().replaceAll(' ', '-')}`,
            title,
            sidebar_title: '',
            description: '',
        })),
        sections: sections.map(([page, heading, text]) => ({
            page: titles.indexOf(page),
            heading,
            anchor: heading === '' ? null : heading.toLowerCase().replaceAll(' ', '-'),
            text,
        })),
    };
}

describe('DocsSearch, on a small index', () => {
    const search = new DocsSearch(
        indexOf([
            ['Check access', '', 'Ask Mesub whether a customer may use a plan.'],
            ['Check access', 'Ask the question', '`hasAccess` answers true or false.'],
            ['Check access', 'Errors', 'A plan that is not yours answers `plan_not_found`.'],
            ['Lifecycle', '', 'Every status of a subscription, and what it grants.'],
            ['Lifecycle', 'The reason', 'When it is over the reason reads `plan_ended`.'],
            ['Lifecycle', 'Late payments', 'A plan has an end. The plan ended. A charge missed.'],
            ['Webhooks', '', 'React when a subscription changes.'],
            ['Webhooks', 'Events', '`subscription.renewal_upcoming` is sent before a charge.'],
            ['Webhooks', 'Retries', 'A delivery that fails is sent again.'],
            ['Pricing', 'Retries', 'The paid tiers retry a missed charge. A webhook is free.'],
        ]),
    );
    const top = (query: string) => search.search(query, 10).map((hit) => hit.url);

    it('builds the URL of a section from its page and its anchor', () => {
        expect(top('hasAccess')[0]).toBe(`${DOCS_BASE_URL}/docs/check-access#ask-the-question`);
        expect(top('React when a subscription changes')[0]).toBe(`${DOCS_BASE_URL}/docs/webhooks`);
    });

    it('finds an identifier whatever its casing, and by its last segment', () => {
        for (const query of ['hasAccess', 'hasaccess', 'HASACCESS']) {
            expect(top(query)[0]).toMatch(/#ask-the-question$/);
        }
        expect(top('renewal_upcoming')[0]).toMatch(/webhooks#events$/);
        expect(top('subscription.renewal_upcoming')[0]).toMatch(/webhooks#events$/);
    });

    it('puts the identifier written whole above the words it is made of', () => {
        // "Late payments" says "plan" and "ended" more often, never `plan_ended`.
        expect(top('plan ended')[0]).toMatch(/lifecycle#late-payments$/);
        expect(top('plan_ended')[0]).toMatch(/lifecycle#the-reason$/);
    });

    it('puts a heading saying the word above a text saying it', () => {
        expect(top('retries')[0]).toMatch(/#retries$/);
        expect(top('errors')[0]).toMatch(/#errors$/);
    });

    it('puts what opens the page titled with the word above a page mentioning it', () => {
        const hits = top('webhook');
        expect(hits[0]).toBe(`${DOCS_BASE_URL}/docs/webhooks`);
        expect(hits).toContainEqual(expect.stringMatching(/pricing#retries$/));
    });

    it('puts a section saying every word above one saying a single one', () => {
        expect(top('missed charge retry')[0]).toMatch(/pricing#retries$/);
    });

    it('forgives a typo in a word the docs do not use', () => {
        expect(top('hasAcess')[0]).toMatch(/#ask-the-question$/);
        expect(top('renewal_upcomming')[0]).toMatch(/webhooks#events$/);
        expect(top('wehbook')[0]).toContain('/docs/webhooks');
    });

    it('scores a typo under the word written right', () => {
        const right = search.search('hasAccess', 1)[0];
        const wrong = search.search('hasAcess', 1)[0];
        expect(wrong?.score).toBeLessThan(right?.score ?? 0);
    });

    it('does not forgive a short word, nor a first letter', () => {
        expect(top('plam')).toEqual([]);
        expect(top('qebhook')).toEqual([]);
    });

    it.each(['kubernetes', 'the of and what', '???', '   ', ''])(
        'returns nothing for "%s"',
        (query) => {
            expect(top(query)).toEqual([]);
        },
    );

    it('leaves the words a question is asked with out of it', () => {
        expect(top('what is the hasAccess')).toEqual(top('hasAccess'));
    });

    it('returns as many hits as asked at most, best first', () => {
        const hits = search.search('plan', 2);
        expect(hits).toHaveLength(2);
        expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
        expect(search.search('plan', 0)).toEqual([]);
    });

    it('gives the same answer to the same query', () => {
        expect(search.search('plan end', 10)).toEqual(search.search('plan end', 10));
    });
});

describe('passage', () => {
    const weights = (query: string) => new Map(terms(query).map((term) => [term, 1]));

    it('starts near the line that matches and keeps whole lines', () => {
        const lines = Array.from({ length: 60 }, (_, at) => `Line ${at} says nothing of it.`);
        lines[40] = 'Then `hasAccess` answers.';
        const found = passage(lines.join('\n'), weights('hasAccess'));

        expect(found.length).toBeLessThanOrEqual(MAX_PASSAGE_LENGTH);
        expect(found.split('\n')[3]).toBe('Then `hasAccess` answers.');
        expect(found.split('\n')[0]).toBe('Line 37 says nothing of it.');
        for (const line of found.split('\n')) expect(lines).toContain(line);
    });

    it('opens the section when only its heading matched', () => {
        expect(passage('First.\nSecond.', weights('absent'))).toBe('First.\nSecond.');
    });

    it('cuts a line longer than a passage around the match, between words', () => {
        const line = `${'before '.repeat(300)}hasAccess ${'after '.repeat(300)}`.trim();
        const found = passage(line, weights('hasAccess'));

        expect(found.length).toBeLessThanOrEqual(MAX_PASSAGE_LENGTH);
        expect(found).toMatch(/^\.\.\. before /);
        expect(found).toContain(' hasAccess after ');
        expect(found).toMatch(/ after \.\.\.$/);
    });

    it('never cuts a character in two', () => {
        const found = passage('😀'.repeat(MAX_PASSAGE_LENGTH), weights('absent'));
        expect(found.length).toBeLessThanOrEqual(MAX_PASSAGE_LENGTH);
        expect(found).not.toMatch(
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
        );
    });
});

// The index the server ships: built from the real docs and committed, so these
// run everywhere. A query that stops finding its page after the docs changed
// is worth a look before the expectation is moved.
describe('DocsSearch, on the Mesub docs', () => {
    const search = new DocsSearch(DOCS_INDEX);
    const TOP = 3;
    const top = (query: string, count = TOP) =>
        search.search(query, count).map((hit) => hit.url.slice(DOCS_BASE_URL.length));

    it.each([
        ['hasAccess', '/docs/access'],
        ['plan_ended', '/reference/errors'],
        ['plan_ended', '/docs/lifecycle'],
        ['verify a webhook signature', '/docs/webhooks'],
        ['what happens when the plan ends', '/docs/lifecycle'],
        ['test without paying', '/docs/testing'],
        ['renewal_upcoming', '/reference/webhooks/subscription-renewal-upcoming'],
        ['subscription.renewal_upcoming', '/reference/webhooks/subscription-renewal-upcoming'],
        ['MESUB_API_KEY', '/docs/api-key'],
        ['close_too_early', '/reference/errors'],
        ['how do I rotate my API key', '/docs/api-key'],
        ['what is a parked seat', '/docs/lifecycle'],
        ['cancel a subscription', '/reference/manage/cancel'],
        ['late payment retry', '/docs/lifecycle'],
        // Typos.
        ['hasAcess', '/docs/access'],
        ['renewal_upcomming', '/reference/webhooks/subscription-renewal-upcoming'],
        ['verify a webhok signature', '/docs/webhooks'],
        ['cancell a subscripton', '/reference/manage/cancel'],
    ])(`finds "%s" on %s, in the first ${TOP}`, (query, page) => {
        const pages = top(query).map((url) => url.split('#')[0]);
        expect(pages).toContain(page);
    });

    it.each([
        ['what happens when the plan ends', '/docs/lifecycle#when-the-plan-has-an-end-date'],
        ['test without paying', '/docs/testing'],
        ['how do I rotate my API key', '/docs/api-key#rotate-it'],
        ['renewal_upcoming', '/reference/webhooks/subscription-renewal-upcoming'],
        ['what is a parked seat', '/docs/lifecycle#parked-seats'],
    ])('answers "%s" with %s first', (query, url) => {
        expect(top(query, 1)).toEqual([url]);
    });

    it('finds the guide of an event next to its reference', () => {
        expect(top('renewal_upcoming', 10)).toContain('/docs/webhooks#before-a-renewal');
    });

    it.each([
        'kubernetes ingress',
        'refund an invoice with stripe',
        'zzzz qqqq',
        'what is the',
        '!!! ???',
    ])('finds nothing for "%s"', (query) => {
        expect(top(query, 10)).toEqual([]);
    });

    it('shows the matching part of the section in the passage', () => {
        const [hit] = search.search('close_too_early', 1);
        expect(hit?.passage).toContain('close_too_early');

        const [code] = search.search('mesub.webhooks.verify', 1);
        expect(code?.passage).toContain('mesub.webhooks.verify');
    });

    it('keeps every passage within its cap, whatever is asked', () => {
        const queries = [
            ...DOCS_INDEX.pages.map((page) => page.title),
            ...DOCS_INDEX.sections.map((section) => section.heading),
            'transaction',
            'data',
            'subscription',
            '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        ];
        let seen = 0;
        for (const query of queries) {
            for (const hit of search.search(query, 10)) {
                seen++;
                expect(hit.passage.length).toBeLessThanOrEqual(MAX_PASSAGE_LENGTH);
                expect(hit.passage.length).toBeGreaterThan(0);
                expect(hit.url.startsWith(`${DOCS_BASE_URL}/`)).toBe(true);
            }
        }
        expect(seen).toBeGreaterThan(500);
    });

    it('is ready in well under a second, and answers in a few milliseconds', () => {
        const started = performance.now();
        const fresh = new DocsSearch(DOCS_INDEX);
        const ready = performance.now() - started;

        const asked = performance.now();
        for (let i = 0; i < 50; i++) fresh.search('what happens when the plan ends', 10);
        const each = (performance.now() - asked) / 50;

        expect(ready).toBeLessThan(1000);
        expect(each).toBeLessThan(50);
    });
});
