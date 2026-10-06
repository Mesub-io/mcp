import { readFileSync, writeFileSync } from 'node:fs';

import * as prettier from 'prettier';

import { TOOLS } from '../src/tools/index.js';
import { TABLE_END, TABLE_START, toolsTable } from './tools-table.js';

// The README's list of tools is written from the registry, so it cannot say
// another thing. `pnpm readme:tools` rewrites it; without it, this fails when
// the two differ.

const README = new URL('../README.md', import.meta.url);

const formatted = (markdown: string) =>
    prettier.format(markdown, { parser: 'markdown', tabWidth: 4, printWidth: 100 });

describe('the README', () => {
    it('lists the tools of the registry, by group, and nothing else', async () => {
        const readme = readFileSync(README, 'utf8');
        const start = readme.indexOf(TABLE_START);
        const end = readme.indexOf(TABLE_END);
        expect(start, 'the README has no tools table to write').toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);

        const wanted = (await formatted(toolsTable())).trimEnd();
        if (process.env.README_WRITE === '1') {
            writeFileSync(
                README,
                `${readme.slice(0, start)}${TABLE_START}\n\n${wanted}\n\n${readme.slice(end)}`,
            );
            return;
        }

        const written = readme.slice(start + TABLE_START.length, end).trim();
        expect(written, 'run `pnpm readme:tools`').toBe(wanted);
    });

    it('names every tool once in its table, and counts them right', () => {
        const readme = readFileSync(README, 'utf8');
        const table = readme.slice(readme.indexOf(TABLE_START), readme.indexOf(TABLE_END));

        for (const tool of TOOLS) {
            expect(table.split(`| \`${tool.name}\``).length - 1, tool.name).toBe(1);
        }
        expect(readme).toContain(`${TOOLS.length} tools`);
        expect(table).toMatch(/\*\*Read\*\* \(14\)/);
        expect(table).toMatch(/\*\*Act\*\* \(8\)/);
        expect(table).toMatch(/\*\*Prepare\*\* \(1\)/);
    });

    it('promises no address, no key and nothing Mesub removed', () => {
        const readme = readFileSync(README, 'utf8');

        // One address at most, and marked as not live yet.
        expect(readme.split('https://mcp.mesub.io').length - 1).toBeLessThanOrEqual(3);
        expect(readme).toMatch(/PLACEHOLDER/);
        expect(readme).toMatch(/not hosted yet/i);
        for (const gone of [
            /secret key/i,
            /publishable key/i,
            /allowed origins? of the project/i,
            /agent_write_cap/,
            /devnet|mainnet/i,
            /\u2014/,
            /resend_webhook_delivery/,
        ]) {
            expect(readme).not.toMatch(gone);
        }
    });

    it('names every variable of .env.example, and no value of a secret', () => {
        const readme = readFileSync(README, 'utf8');
        const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
        const variables = [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map(
            (match) => match[1],
        );

        expect(variables.length).toBeGreaterThan(8);
        for (const variable of new Set(variables)) expect(readme, variable).toContain(variable);
        expect(readme).not.toMatch(/MESUB_SERVICE_SECRET=[A-Za-z0-9+/]{16,}/);
    });
});
