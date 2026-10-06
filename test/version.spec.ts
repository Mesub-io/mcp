import { readFileSync } from 'node:fs';

import { VERSION } from '../src/version.js';

describe('VERSION', () => {
    it('is the version in package.json', () => {
        const manifest = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ) as { version: string };
        expect(VERSION).toBe(manifest.version);
    });
});
