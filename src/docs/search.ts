import { DOCS_BASE_URL, type DocsIndex, type DocsPage, type DocsSection } from './docs-index.js';

// A lexical search over a few hundred sections: BM25 with the fields of a
// section weighted, identifiers matched whole, and a typo forgiven when the
// word is not one the docs use. No service, no model: the same query on the
// same index gives the same answer.

/** The longest passage a hit carries, in characters. */
export const MAX_PASSAGE_LENGTH = 800;
/** How many lines before the matching one a passage may start. */
const LINES_BEFORE = 3;

// BM25's own two knobs. B is under its usual 0.75: a long section here is a
// table of statuses or of error codes, which is what is looked up.
const K1 = 1.2;
const B = 0.4;

// A word in a section's own heading, or in the title of its page, counts on
// top of what the text says of it: each field saturates by itself, so a
// heading naming the word is worth about as much as a text insisting on it.
const HEADING_WEIGHT = 1.5;
const TITLE_WEIGHT = 0.5;

/** An identifier written whole (`plan_ended`, `hasAccess`) against the words it is made of. */
const IDENTIFIER_WEIGHT = 2;
const IDENTIFIER_PART_WEIGHT = 0.25;
/** What a word found only by forgiving a typo is worth, per edit. */
const TYPO_WEIGHT = 0.6;
/** A section matching every word of the query against one matching a single word. */
const COVERAGE_FLOOR = 0.4;
/** A hit this far under the best one is noise: one common word of a long question. */
const RELATIVE_FLOOR = 0.15;

// Words a question is asked with. Dropped from a query, never from the docs.
const STOPWORDS = new Set(
    (
        'a an and are as at be by can could do does did for from ' +
        'happen happens how i if in is it its me mean means my of on or should so that the ' +
        'their then there these this those to was were what when where which who why will ' +
        'with would you your'
    ).split(' '),
);

const RAW_TOKEN = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/gu;

/** `hasAccess` to `has`, `Access`; `MESUB_API_KEY` to its three words. */
function words(segment: string): string[] {
    return segment
        .split(/[_-]+/)
        .flatMap((piece) =>
            piece.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u),
        )
        .filter((piece) => piece !== '');
}

/**
 * A light English stemmer, enough for "ends" to find "ended" and "paying" to
 * find "pay". Stems are only ever compared with stems.
 */
export function stem(word: string): string {
    let stemmed = word;
    // The plural first, so "integrations" then loses what "integration" loses.
    if (stemmed.length > 4 && stemmed.endsWith('ies')) stemmed = `${stemmed.slice(0, -3)}y`;
    else if (stemmed.length > 3 && /[^su]s$/.test(stemmed) && !stemmed.endsWith('is')) {
        stemmed = stemmed.slice(0, -1);
    }

    if (stemmed.length > 4 && stemmed.endsWith('ied')) stemmed = `${stemmed.slice(0, -3)}y`;
    else if (stemmed.length > 6 && stemmed.endsWith('ion')) stemmed = stemmed.slice(0, -3);
    else if (stemmed.length > 5 && stemmed.endsWith('ing')) stemmed = stemmed.slice(0, -3);
    else if (stemmed.length > 4 && stemmed.endsWith('ed')) stemmed = stemmed.slice(0, -2);

    if (stemmed.length > 4 && stemmed.endsWith('e')) stemmed = stemmed.slice(0, -1);
    // "stopped" and "stop", "cancelled" and "cancel".
    if (stemmed.length > 3 && /([^aeiousz])\1$/.test(stemmed)) stemmed = stemmed.slice(0, -1);
    return stemmed;
}

export interface Token {
    /** What is indexed and looked up. */
    term: string;
    /** As written, lowercased: what a typo is compared with. */
    surface: string;
    /** Whether it is an identifier written whole, or one of the words making it. */
    kind: 'word' | 'identifier' | 'part';
    /** The position of the written word it comes from. */
    group: number;
}

/**
 * The terms of a text. A plain word gives its stem. An identifier gives itself
 * whole, lowercased (`subscription.renewal_upcoming`, `hasaccess`), its
 * dotted endings and segments (`renewal_upcoming`), and the stems of its words.
 */
export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let group = 0;
    for (const [raw] of text.matchAll(RAW_TOKEN)) {
        const whole = raw.toLowerCase();
        const segments = raw.split('.');
        const parts = segments.flatMap(words);

        if (parts.length <= 1) {
            tokens.push({ term: stem(whole), surface: whole, kind: 'word', group });
        } else {
            const identifiers = new Set([whole]);
            segments.forEach((segment, at) => {
                // `mesub.webhooks.verify` is also looked up as `webhooks.verify`.
                if (at > 0 && at < segments.length - 1) {
                    identifiers.add(segments.slice(at).join('.').toLowerCase());
                }
                if (segments.length > 1 && words(segment).length > 1) {
                    identifiers.add(segment.toLowerCase());
                }
            });
            for (const identifier of identifiers) {
                tokens.push({ term: identifier, surface: identifier, kind: 'identifier', group });
            }
            for (const part of parts) {
                const surface = part.toLowerCase();
                tokens.push({ term: stem(surface), surface, kind: 'part', group });
            }
        }
        group++;
    }
    return tokens;
}

/** BM25's saturation: a word said ten times is not worth ten times a word said once. */
const saturated = (count: number) => (count * (K1 + 1)) / (count + K1);

/** Edits between two words, a swap of neighbours counting for one. Stops counting past `max`. */
export function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let previous: number[] = [];
    let current = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(
                (current[j] ?? 0) + 1,
                (next[j - 1] ?? 0) + 1,
                (current[j - 1] ?? 0) + cost,
            );
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                value = Math.min(value, (previous[j - 2] ?? 0) + 1);
            }
            next.push(value);
            best = Math.min(best, value);
        }
        if (best > max) return max + 1;
        previous = current;
        current = next;
    }
    return current[b.length] ?? max + 1;
}

/** How many typos a word of this length is forgiven. Short words, none. */
function typosAllowed(surface: string): number {
    if (surface.length >= 9) return 2;
    return surface.length >= 5 ? 1 : 0;
}

export interface SearchHit {
    page: DocsPage;
    section: DocsSection;
    /** Where the section is on the docs site. */
    url: string;
    /** The part of the section that matches, `MAX_PASSAGE_LENGTH` characters at most. */
    passage: string;
    score: number;
}

/** One written word of the query: the terms it may be found as, and what each is worth. */
interface QueryWord {
    alternatives: { term: string; weight: number }[];
}

/** An index made ready to search. Built once, read by every search, never written to. */
export class DocsSearch {
    readonly #index: DocsIndex;
    /** term, then section, then how much the section says it: its fields, saturated and weighted. */
    readonly #postings = new Map<string, Map<number, number>>();
    /** Every word as written, and the term it is indexed as. */
    readonly #surfaces = new Map<string, string>();

    constructor(index: DocsIndex) {
        this.#index = index;

        const fields = index.sections.map((section) => {
            const page = index.pages[section.page];
            return [
                section.text,
                // What opens a page is headed by the page's own title.
                section.heading || (page?.title ?? ''),
                `${page?.title ?? ''} ${page?.sidebar_title ?? ''}`,
            ].map((text) => {
                const terms = new Map<string, number>();
                const tokens = tokenize(text);
                for (const { term, surface } of tokens) {
                    terms.set(term, (terms.get(term) ?? 0) + 1);
                    this.#surfaces.set(surface, term);
                }
                return { terms, length: tokens.length };
            });
        });

        const lengths = fields.map(([text]) => text?.length ?? 0);
        const average = lengths.reduce((sum, length) => sum + length, 0) / (lengths.length || 1);

        fields.forEach(([text, heading, title], at) => {
            // Only the text is long enough for its length to say anything.
            const norm = 1 - B + B * ((lengths[at] ?? 0) / (average || 1));
            const add = (terms: Map<string, number> | undefined, weight: number, by = 1) => {
                for (const [term, count] of terms ?? []) {
                    const sections = this.#postings.get(term) ?? new Map<number, number>();
                    sections.set(at, (sections.get(at) ?? 0) + weight * saturated(count / by));
                    this.#postings.set(term, sections);
                }
            };
            add(text?.terms, 1, norm);
            add(heading?.terms, HEADING_WEIGHT);
            add(title?.terms, TITLE_WEIGHT);
        });
    }

    /** The best sections for a query, best first. Empty when nothing matches. */
    search(query: string, limit: number): SearchHit[] {
        const asked = this.#read(query);
        if (asked.length === 0) return [];

        const scores = new Map<number, { score: number; matched: number }>();
        for (const word of asked) {
            // A word found several ways counts once, for its best way.
            const best = new Map<number, number>();
            for (const { term, weight } of word.alternatives) {
                for (const [section, said] of this.#postings.get(term) ?? []) {
                    const value = weight * this.#idf(term) * said;
                    best.set(section, Math.max(best.get(section) ?? 0, value));
                }
            }
            for (const [section, value] of best) {
                const entry = scores.get(section) ?? { score: 0, matched: 0 };
                scores.set(section, { score: entry.score + value, matched: entry.matched + 1 });
            }
        }

        const ranked = [...scores]
            .map(([section, { score, matched }]) => ({
                section,
                score: score * (COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * (matched / asked.length)),
            }))
            // The order of the docs settles a tie, so an answer never depends on a Map's order.
            .sort((a, b) => b.score - a.score || a.section - b.section);

        const floor = (ranked[0]?.score ?? 0) * RELATIVE_FLOOR;
        const terms = new Map<string, number>();
        for (const word of asked) {
            for (const { term, weight } of word.alternatives) {
                terms.set(term, Math.max(terms.get(term) ?? 0, weight * this.#idf(term)));
            }
        }

        return ranked
            .filter((entry) => entry.score >= floor)
            .slice(0, Math.max(0, limit))
            .flatMap(({ section: at, score }) => {
                const section = this.#index.sections[at];
                const page = section && this.#index.pages[section.page];
                if (!section || !page) return [];
                return {
                    page,
                    section,
                    url: `${DOCS_BASE_URL}${page.path}${section.anchor ? `#${section.anchor}` : ''}`,
                    passage: passage(section.text, terms),
                    score: Math.round(score * 100) / 100,
                };
            });
    }

    /** Rarer is worth more. Never negative, whatever the share of sections saying it. */
    #idf(term: string): number {
        const total = this.#index.sections.length;
        const saying = this.#postings.get(term)?.size ?? 0;
        return Math.log(1 + (total - saying + 0.5) / (saying + 0.5));
    }

    /** A query as words to look for, the ones a question is merely asked with left out. */
    #read(query: string): QueryWord[] {
        const groups = new Map<number, Token[]>();
        for (const token of tokenize(query)) {
            groups.set(token.group, [...(groups.get(token.group) ?? []), token]);
        }

        const asked: QueryWord[] = [];
        for (const tokens of groups.values()) {
            const alternatives: QueryWord['alternatives'] = [];
            for (const token of tokens) {
                if (token.kind === 'word' && STOPWORDS.has(token.surface)) continue;
                const weight =
                    token.kind === 'identifier'
                        ? IDENTIFIER_WEIGHT
                        : token.kind === 'part'
                          ? IDENTIFIER_PART_WEIGHT
                          : 1;

                // Typed without its capitals, `hasaccess` is still the identifier.
                const known = [token.term, token.surface].filter((term) =>
                    this.#postings.has(term),
                );
                if (known.length > 0) {
                    for (const term of new Set(known)) alternatives.push({ term, weight });
                } else if (token.kind !== 'part') {
                    alternatives.push(...this.#forgiven(token.surface, weight));
                }
            }
            if (alternatives.length > 0) asked.push({ alternatives });
        }
        return asked;
    }

    /** The words of the docs a word they do not use may be a typo of: the closest ones only. */
    #forgiven(surface: string, weight: number): QueryWord['alternatives'] {
        const allowed = typosAllowed(surface);
        if (allowed === 0) return [];

        let closest = allowed + 1;
        let terms = new Set<string>();
        for (const [candidate, term] of this.#surfaces) {
            // A typo rarely lands on the first letter, and a first letter rules most words out.
            if (candidate[0] !== surface[0] || STOPWORDS.has(candidate)) continue;
            const distance = editDistance(surface, candidate, Math.min(allowed, closest));
            if (distance < closest) [closest, terms] = [distance, new Set([term])];
            else if (distance === closest && distance <= allowed) terms.add(term);
        }
        return [...terms].map((term) => ({ term, weight: weight * TYPO_WEIGHT ** closest }));
    }
}

/**
 * The lines of a text around the one that says the most of what was asked,
 * within `MAX_PASSAGE_LENGTH`. Whole lines: a line of code is not cut unless
 * it is longer than a passage by itself.
 */
export function passage(text: string, terms: ReadonlyMap<string, number>): string {
    const lines = text.split('\n');
    let start = 0;
    let best = 0;
    lines.forEach((line, at) => {
        const said = new Set(tokenize(line).flatMap((token) => [token.term, token.surface]));
        let value = 0;
        for (const [term, weight] of terms) if (said.has(term)) value += weight;
        if (value > best) [best, start] = [value, at];
    });

    const first = lines[start] ?? '';
    if (first.length > MAX_PASSAGE_LENGTH) return cut(first, terms);

    let end = start + 1;
    let length = first.length;
    const fits = (line: string | undefined): line is string =>
        line !== undefined && length + 1 + line.length <= MAX_PASSAGE_LENGTH;
    // What follows the line says more of it; a few lines before it say what it is in.
    for (; fits(lines[end]); end++) length += 1 + (lines[end]?.length ?? 0);
    for (let back = 0; back < LINES_BEFORE && start > 0 && fits(lines[start - 1]); back++) {
        start--;
        length += 1 + (lines[start]?.length ?? 0);
    }

    return lines.slice(start, end).join('\n');
}

const ELLIPSIS = '...';

/** A line longer than a passage, cut around the first word that matches, between words. */
function cut(line: string, terms: ReadonlyMap<string, number>): string {
    let at = 0;
    for (const match of line.matchAll(RAW_TOKEN)) {
        if (tokenize(match[0]).some((token) => terms.has(token.term) || terms.has(token.surface))) {
            at = match.index;
            break;
        }
    }

    const room = MAX_PASSAGE_LENGTH - 2 * (ELLIPSIS.length + 1);
    let from = Math.max(0, Math.min(at - Math.floor(room / 4), line.length - room));
    if (from > 0) {
        const space = line.indexOf(' ', from);
        if (space !== -1 && space < at) from = space + 1;
    }
    let to = Math.min(line.length, from + room);
    if (to < line.length) {
        const space = line.lastIndexOf(' ', to);
        if (space > from + room / 2) to = space;
    }
    // Never half of a character written on two code units.
    if (isHighSurrogate(line.charCodeAt(to - 1))) to--;
    if (isHighSurrogate(line.charCodeAt(from - 1))) from++;

    const kept = line.slice(from, to).trim();
    return `${from > 0 ? `${ELLIPSIS} ` : ''}${kept}${to < line.length ? ` ${ELLIPSIS}` : ''}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
