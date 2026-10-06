#!/usr/bin/env node
// Builds src/docs/index.json, what `search_docs` searches: every page of the
// Mesub docs (the repository Mesub-io/docs) cut into sections of plain text.
//
//   node scripts/build-docs-index.mjs            from a local checkout if one is
//                                                there, else from the pinned commit
//   node scripts/build-docs-index.mjs --docs DIR from that checkout, at its HEAD
//   node scripts/build-docs-index.mjs --commit SHA   from that commit, fetched
//   node scripts/build-docs-index.mjs --latest   from the tip of the docs' main
//   node scripts/build-docs-index.mjs --check    exit 1 unless the committed index
//                                                is what its own commit builds
//   node scripts/build-docs-index.mjs --stale    exit 1 when the docs' main would
//                                                build other sections
//
// The pin is the commit the committed index names: there is no second file.
// Nothing here depends on when or where it runs, so one commit builds one file.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DOCS_REPOSITORY = 'Mesub-io/docs';
export const DOCS_GIT_URL = `https://github.com/${DOCS_REPOSITORY}.git`;
export const INDEX_VERSION = 1;

/** A title or a heading longer than this stops the build: the tool bounds what it returns. */
const MAX_LABEL = 200;
const MAX_FIELD_DEPTH = 3;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_FILE = join(ROOT, 'src/docs/index.json');
/** Where the docs sit next to this repository on a machine that has both. */
const SIBLING = resolve(ROOT, '../docs-site');

/**
 * @typedef {{ commit: string, committed_at: string }} Source
 * @typedef {{ path: string, title: string, sidebar_title: string, description: string }} Page
 * @typedef {{ page: number, heading: string, anchor: string | null, text: string }} Section
 * @typedef {{
 *   version: number,
 *   source: { repository: string, commit: string, committed_at: string },
 *   pages: Page[],
 *   sections: Section[],
 * }} DocsIndex
 * @typedef {Record<string, any>} Json
 */

/**
 * JSON with comments and trailing commas, as docs.jsonc is written.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            const start = i;
            for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
            out += text.slice(start, i + 1);
        } else if (char === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (char === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 1;
        } else if (char === '}' || char === ']') {
            out = out.replace(/,\s*$/, '') + char;
        } else {
            out += char;
        }
    }
    return JSON.parse(out);
}

/**
 * The top-level keys of a page's frontmatter. A block (`prompt: |`) is skipped.
 * @param {string} mdx
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(mdx) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(mdx);
    if (!match) return { data: {}, body: mdx };

    /** @type {Record<string, string>} */
    const data = {};
    for (const line of (match[1] ?? '').split(/\r?\n/)) {
        const pair = /^([A-Za-z$][\w$]*):\s*(.*)$/.exec(line);
        if (!pair) continue;
        const key = pair[1] ?? '';
        let value = (pair[2] ?? '').trim();
        if (value === '' || value === '|' || value === '>') continue;
        if (value.startsWith('"')) value = String(JSON.parse(value));
        else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1).replaceAll("''", "'");
        }
        data[key] = value;
    }
    return { data, body: mdx.slice(match[0].length) };
}

/**
 * Heading ids as the docs site makes them: its framework slugs with
 * github-slugger. Lowercase, punctuation dropped, spaces to hyphens, and a
 * number after a slug already taken on the page.
 */
export class Slugger {
    /** @type {Set<string>} */
    #taken = new Set();

    /** @param {string} text */
    slug(text) {
        const base = text
            .toLowerCase()
            .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
            .replace(/ /g, '-');
        let slug = base;
        for (let n = 1; this.#taken.has(slug); n++) slug = `${base}-${n}`;
        this.#taken.add(slug);
        return slug;
    }

    /**
     * An id written by hand on the heading.
     * @param {string} id
     */
    take(id) {
        this.#taken.add(id);
        return id;
    }
}

/**
 * One line of prose as plain text: links to their words, tags dropped (the
 * title one carries is kept), emphasis marks removed. Inline code is left alone.
 * @param {string} text
 */
function plain(text) {
    return text
        .replace(/!?\[((?:[^\]\\]|\\.)*)\]\([^()\s]*(?:\s+"[^"]*")?\)/g, '$1')
        .split(/(`[^`]*`)/)
        .map((part, i) =>
            i % 2 === 1
                ? part
                : part
                      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
                      .replace(/<\/?[A-Za-z][^<>]*>/g, (tag) => {
                          const title = /\stitle="([^"]*)"/.exec(tag)?.[1];
                          return title ? `${title}:` : '';
                      })
                      .replace(/\*\*([^*]+)\*\*/g, '$1'),
        )
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

/** @param {string} text */
const headingText = (text) => plain(text).replaceAll('`', '');

/**
 * A page's body, cut at its headings. Code blocks are kept as written;
 * everything else becomes plain text, one paragraph, row or item per line.
 * @param {string} body
 * @param {(kind: 'endpoint' | 'schema', name: string) => string[]} [component] what a
 *   reference component draws in place, as lines
 * @returns {{ heading: string, anchor: string | null, lines: string[] }[]}
 */
export function splitSections(body, component = () => []) {
    const slugger = new Slugger();
    /** @type {{ heading: string, anchor: string | null, lines: string[] }[]} */
    const sections = [{ heading: '', anchor: null, lines: [] }];
    /** @type {string[]} */
    let paragraph = [];
    /** @type {string | null} the marker of the code block being read */
    let fence = null;
    let skippingEsm = false;

    const current = () => /** @type {(typeof sections)[number]} */ (sections.at(-1));
    const flush = () => {
        const text = plain(paragraph.join(' '));
        if (text !== '') current().lines.push(text);
        paragraph = [];
    };
    /** @param {string} text  @param {string} [id] */
    const open = (text, id) => {
        flush();
        const heading = headingText(text);
        sections.push({
            heading,
            anchor: id ? slugger.take(id) : slugger.slug(heading),
            lines: [],
        });
    };

    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();

        if (fence !== null) {
            if (line.startsWith(fence) && line.slice(fence.length).trim() === '') {
                current().lines.push('```');
                fence = null;
            } else {
                current().lines.push(raw.trimEnd());
            }
            continue;
        }

        const opening = /^(`{3,}|~{3,})\s*(.*)$/.exec(line);
        if (opening) {
            flush();
            fence = opening[1] ?? '```';
            current().lines.push(`\`\`\`${fenceLabel(opening[2] ?? '')}`);
            continue;
        }

        // An ESM statement of the page itself, up to the next blank line.
        if (skippingEsm) {
            skippingEsm = line !== '';
            continue;
        }
        if (/^(import|export)\s/.test(raw)) {
            flush();
            skippingEsm = true;
            continue;
        }

        if (line === '') {
            flush();
            continue;
        }

        const markdownHeading = /^#{1,6}\s+(.*?)(?:\s*\{#([^}\s]+)\})?\s*#*$/.exec(line);
        if (markdownHeading) {
            open(markdownHeading[1] ?? '', markdownHeading[2]);
            continue;
        }
        const jsxHeading = /^<(h[1-6])\b([^>]*)>(.*)<\/\1>$/.exec(line);
        if (jsxHeading) {
            open(jsxHeading[3] ?? '', /\sid="([^"]+)"/.exec(jsxHeading[2] ?? '')?.[1]);
            continue;
        }

        if (line.startsWith('<')) {
            flush();
            const endpoint = /^<Endpoint\s[^>]*\bid="([^"]+)"/.exec(line)?.[1];
            const schema = /^<SchemaFields\s[^>]*\bname="([^"]+)"/.exec(line)?.[1];
            if (endpoint) current().lines.push(...component('endpoint', endpoint));
            else if (schema) current().lines.push(...component('schema', schema));
            else {
                paragraph.push(line);
                flush();
            }
            continue;
        }

        if (line.startsWith('|')) {
            flush();
            if (/^\|[\s:|-]+$/.test(line)) continue;
            const cells = line.replace(/^\||\|$/g, '').split('|');
            current().lines.push(cells.map(plain).join(' | '));
            continue;
        }

        if (/^([-*+]|\d+[.)])\s+/.test(line)) flush();
        paragraph.push(line.replace(/^>\s?/, ''));
    }
    flush();

    return sections;
}

/**
 * ```` ```ts Express ```` and ```` ```bash title="cURL" lines=false ```` both name their sample.
 * @param {string} info
 */
function fenceLabel(info) {
    const [language = '', ...rest] = info.trim().split(/\s+/);
    const meta = rest.join(' ');
    const title = /\btitle="([^"]*)"/.exec(meta)?.[1] ?? (meta.includes('=') ? '' : meta);
    return [language, title].filter((part) => part !== '').join(' ');
}

/**
 * The fields of a schema, one line each: `` `name`: what it holds ``. An
 * object named elsewhere in the spec (`$ref`) is unfolded at the top only:
 * inside another, its own page says it.
 * @param {Json} spec
 */
function fieldReader(spec) {
    /** @param {Json | undefined} node  @returns {Json} */
    const deref = (node) => {
        if (!node) return {};
        if (typeof node.$ref !== 'string') return node;
        return deref(spec.components?.schemas?.[node.$ref.split('/').pop() ?? '']);
    };

    /** @param {Json | undefined} node  @param {boolean} top  @returns {Json} */
    const properties = (node, top) => {
        if (!node || (!top && typeof node.$ref === 'string')) return {};
        const schema = deref(node);
        if (schema.type === 'array' || schema.items) return properties(schema.items, top);
        /** @type {Json} */
        const merged = { ...schema.properties };
        for (const part of schema.allOf ?? []) Object.assign(merged, properties(part, top));
        return merged;
    };

    /** @param {Json | undefined} node  @param {string} prefix  @param {number} depth  @returns {string[]} */
    const lines = (node, prefix = '', depth = 0) =>
        Object.entries(properties(node, depth === 0)).flatMap(([name, child]) => {
            const schema = deref(child);
            const description = plain(child.description ?? schema.description ?? '');
            const values = Array.isArray(schema.enum)
                ? ` One of ${schema.enum
                      .filter((/** @type {unknown} */ value) => value !== null)
                      .map((/** @type {unknown} */ value) => `\`${String(value)}\``)
                      .join(', ')}.`
                : '';
            const path = `${prefix}${name}`;
            return [
                `\`${path}\`: ${description}${values}`.trim(),
                ...(depth + 1 < MAX_FIELD_DEPTH ? lines(child, `${path}.`, depth + 1) : []),
            ];
        });

    return { deref, lines };
}

/**
 * What the reference draws from the OpenAPI document for one operation, as
 * sections without an anchor: the site shows them in tabs.
 * @param {Json} spec
 * @param {string} id
 * @returns {{ lead: string[], sections: { heading: string, lines: string[] }[] }}
 */
function operationSections(spec, id) {
    const { deref, lines } = fieldReader(spec);

    /** @type {Json | undefined} */
    let operation;
    let webhook = false;
    for (const [group, isWebhook] of /** @type {const} */ ([
        [spec.paths, false],
        [spec.webhooks, true],
    ])) {
        for (const methods of Object.values(group ?? {})) {
            for (const candidate of Object.values(/** @type {Json} */ (methods))) {
                if (candidate?.operationId === id) [operation, webhook] = [candidate, isWebhook];
            }
        }
    }
    if (!operation) throw new Error(`No operation "${id}" in public/openapi.json.`);

    /** @param {string} where */
    const parameters = (where) =>
        (operation.parameters ?? [])
            .filter((/** @type {Json} */ parameter) => parameter.in === where)
            .map((/** @type {Json} */ parameter) => {
                const values = Array.isArray(parameter.schema?.enum)
                    ? ` One of ${parameter.schema.enum.map((/** @type {unknown} */ value) => `\`${String(value)}\``).join(', ')}.`
                    : '';
                return `\`${parameter.name}\`: ${plain(parameter.description ?? '')}${values}`.trim();
            });

    const body = lines(operation.requestBody?.content?.['application/json']?.schema);
    const responses = Object.entries(operation.responses ?? {}).flatMap(([status, value]) => {
        const response = /** @type {Json} */ (value);
        const schema = deref(response.content?.['application/json']?.schema);
        const shapes = Array.isArray(schema.oneOf) ? schema.oneOf : [schema];
        return [
            `\`${status}\`: ${plain(response.description ?? '')}`.trim(),
            // An error's body is the same everywhere: its codes are what differs.
            ...(status.startsWith('2') ? shapes.flatMap((shape) => lines(shape)) : []),
            ...(response['x-codes'] ?? []).map(
                (/** @type {Json} */ entry) =>
                    `\`${entry.code}\`: ${plain(entry.when ?? '')}${entry.retryable ? ' Retryable.' : ''}`,
            ),
        ];
    });

    const limit = operation['x-mesub']?.limit;
    const sections = [
        { heading: 'Headers', lines: parameters('header') },
        { heading: 'Path parameters', lines: parameters('path') },
        { heading: 'Query parameters', lines: parameters('query') },
        { heading: webhook ? 'Payload' : 'Body', lines: body },
        { heading: webhook ? 'Your answer' : 'Responses', lines: responses },
    ];
    return {
        lead: limit ? [`Limit: ${limit}.`] : [],
        sections: sections.filter((section) => section.lines.length > 0),
    };
}

/**
 * Every page slug the navigation of docs.jsonc lists, in its order.
 * @param {unknown} node
 * @returns {string[]}
 */
function navigationPages(node) {
    if (Array.isArray(node)) return node.flatMap(navigationPages);
    if (typeof node !== 'object' || node === null) return [];
    return Object.entries(node).flatMap(([key, value]) =>
        key === 'pages' && Array.isArray(value)
            ? value.flatMap((page) => (typeof page === 'string' ? [page] : navigationPages(page)))
            : navigationPages(value),
    );
}

/**
 * The index of a docs checkout. Reads docs.jsonc, the pages it lists under
 * src/, and public/openapi.json for the reference.
 * @param {string} docsDir
 * @param {Source} source
 * @param {{ pages?: string[] }} [options] tests only: the page slugs to read
 * @returns {DocsIndex}
 */
export function buildDocsIndex(docsDir, source, options = {}) {
    const read = (/** @type {string} */ file) => readFileSync(join(docsDir, file), 'utf8');
    const slugs = options.pages ?? navigationPages(parseJsonc(read('docs.jsonc')).navigation ?? {});
    if (slugs.length === 0) throw new Error('docs.jsonc lists no page.');

    const specFile = join(docsDir, 'public/openapi.json');
    /** @type {Json} */
    const spec = existsSync(specFile) ? JSON.parse(readFileSync(specFile, 'utf8')) : {};
    const fields = fieldReader(spec);

    /** @type {Page[]} */
    const pages = [];
    /** @type {Section[]} */
    const sections = [];

    for (const slug of slugs) {
        const file = ['.mdx', '.md']
            .map((ext) => `src/${slug}${ext}`)
            .find((candidate) => existsSync(join(docsDir, candidate)));
        if (!file) throw new Error(`docs.jsonc lists "${slug}", which has no file under src/.`);

        const { data, body } = parseFrontmatter(read(file));
        const title = data.title ?? slug;
        const description = data.description ?? '';
        // As on the docs site: `index` is the root, and a folder's index is the folder.
        const path = slug === 'index' ? '/' : `/${slug.replace(/\/index$/, '')}`;

        /** @type {{ heading: string, lines: string[] }[]} */
        const drawn = [];
        /** @type {string[]} */
        const lead = data.api ? [`\`${data.api}\``] : [];
        const parts = splitSections(body, (kind, name) => {
            if (kind === 'schema') return fields.lines({ $ref: name });
            const operation = operationSections(spec, name);
            lead.push(...operation.lead);
            drawn.push(...operation.sections);
            return [];
        });

        // The page opens with its description, unless its text starts by saying the same.
        const opening = /** @type {(typeof parts)[number]} */ (parts[0]);
        const said = description.replace(/\.{3}$/, '');
        const repeats = opening.lines.some(
            (line) => !line.startsWith('```') && line.startsWith(said),
        );
        opening.lines.unshift(...lead, ...(description !== '' && !repeats ? [description] : []));

        const page = pages.length;
        pages.push({ path, title, sidebar_title: data.sidebarTitle ?? '', description });
        for (const part of [...parts, ...drawn.map((section) => ({ ...section, anchor: null }))]) {
            const text = part.lines.join('\n');
            // A heading with nothing under it but other headings has no passage to give.
            if (text === '') continue;
            sections.push({ page, heading: part.heading, anchor: part.anchor, text });
        }
    }

    for (const label of [...pages.map((page) => page.title), ...sections.map((s) => s.heading)]) {
        if (label.length > MAX_LABEL) {
            throw new Error(`A title or heading is over ${MAX_LABEL} characters: "${label}".`);
        }
    }

    return {
        version: INDEX_VERSION,
        source: { repository: DOCS_REPOSITORY, ...source },
        pages,
        sections,
    };
}

/**
 * The file, one page and one section per line so a change of the docs reads
 * as a diff.
 * @param {DocsIndex} index
 */
export function serializeIndex(index) {
    const list = (/** @type {unknown[]} */ items) =>
        items.length === 0
            ? '[]'
            : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`;
    return [
        '{',
        `  "version": ${JSON.stringify(index.version)},`,
        `  "source": ${JSON.stringify(index.source)},`,
        `  "pages": ${list(index.pages)},`,
        `  "sections": ${list(index.sections)}`,
        '}',
        '',
    ].join('\n');
}

// What follows is the command line.

/** @param {string} cwd  @param {string[]} args */
const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * The commit a checkout sits on. Refuses one whose indexed files differ from it.
 * @param {string} dir
 * @returns {Source}
 */
function sourceOf(dir) {
    const dirty = git(
        dir,
        'status',
        '--porcelain',
        '--',
        'src',
        'docs.jsonc',
        'public/openapi.json',
    );
    if (dirty !== '') {
        throw new Error(`${dir} has changes that are not committed:\n${dirty}`);
    }
    return {
        commit: git(dir, 'rev-parse', 'HEAD'),
        committed_at: new Date(git(dir, 'log', '-1', '--format=%cI', 'HEAD')).toISOString(),
    };
}

/**
 * Runs `use` on a checkout of the docs at a commit or a branch, fetched from GitHub.
 * @template T
 * @param {string} ref
 * @param {(dir: string) => T} use
 * @returns {T}
 */
function withFetched(ref, use) {
    if (!/^[0-9a-f]{40}$|^main$/.test(ref)) throw new Error(`Not a full commit id: "${ref}".`);
    const dir = mkdtempSync(join(tmpdir(), 'mesub-docs-'));
    try {
        git(dir, 'init', '-q');
        git(dir, 'fetch', '-q', '--depth', '1', DOCS_GIT_URL, ref);
        git(dir, 'checkout', '-q', 'FETCH_HEAD');
        return use(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** @param {string} dir */
const buildFrom = (dir) => buildDocsIndex(dir, sourceOf(dir));

/** @returns {DocsIndex | undefined} */
function committedIndex() {
    return existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, 'utf8')) : undefined;
}

/** @param {string[]} argv */
function main(argv) {
    const flag = (/** @type {string} */ name) => argv.includes(name);
    const value = (/** @type {string} */ name) => {
        const at = argv.indexOf(name);
        return at === -1 ? undefined : argv[at + 1];
    };
    const committed = committedIndex();
    const pinned = committed?.source.commit;
    const local =
        value('--docs') ??
        process.env.MESUB_DOCS_DIR ??
        (existsSync(SIBLING) ? SIBLING : undefined);

    if (flag('--check')) {
        if (!committed || !pinned) throw new Error('src/docs/index.json is missing.');
        // A local checkout already on the pinned commit saves the fetch.
        const onPin = local !== undefined && sourceOfOrNull(local)?.commit === pinned;
        const rebuilt = onPin ? buildFrom(local) : withFetched(pinned, buildFrom);
        if (serializeIndex(rebuilt) !== readFileSync(INDEX_FILE, 'utf8')) {
            throw new Error(
                `src/docs/index.json is not what scripts/build-docs-index.mjs builds from ${DOCS_REPOSITORY}@${pinned}. Run \`pnpm docs:index\` and commit the result.`,
            );
        }
        console.log(`src/docs/index.json is what ${DOCS_REPOSITORY}@${pinned.slice(0, 7)} builds.`);
        return;
    }

    if (flag('--stale')) {
        if (!committed || !pinned) throw new Error('src/docs/index.json is missing.');
        const latest = withFetched('main', buildFrom);
        const content = (/** @type {DocsIndex} */ index) =>
            JSON.stringify([index.pages, index.sections]);
        if (content(latest) !== content(committed)) {
            throw new Error(
                `The docs changed since the index was built: it is from ${pinned.slice(0, 7)} (${committed.source.committed_at}), main is at ${latest.source.commit.slice(0, 7)} (${latest.source.committed_at}). Run \`pnpm docs:index --latest\` and commit the result.`,
            );
        }
        console.log(
            `The index says what the docs' main says (${latest.source.commit.slice(0, 7)}).`,
        );
        return;
    }

    const started = performance.now();
    const commit = flag('--latest') ? 'main' : value('--commit');
    let index;
    if (commit !== undefined) index = withFetched(commit, buildFrom);
    else if (local !== undefined) index = buildFrom(local);
    else if (pinned !== undefined) index = withFetched(pinned, buildFrom);
    else
        throw new Error(
            'No docs checkout and no index to take a commit from: pass --docs or --latest.',
        );

    const file = serializeIndex(index);
    writeFileSync(INDEX_FILE, file);
    const was = pinned && pinned !== index.source.commit ? ` (was ${pinned.slice(0, 7)})` : '';
    console.log(
        `src/docs/index.json: ${index.pages.length} pages, ${index.sections.length} sections, ` +
            `${Buffer.byteLength(file)} bytes, in ${Math.round(performance.now() - started)} ms, ` +
            `from ${DOCS_REPOSITORY}@${index.source.commit.slice(0, 7)}${was}.`,
    );
}

/** @param {string} dir */
function sourceOfOrNull(dir) {
    try {
        return sourceOf(dir);
    } catch {
        return null;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
