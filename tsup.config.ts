import { defineConfig } from 'tsup';

// One ESM entry, the process. Dependencies stay in node_modules, unbundled.
export default defineConfig({
    entry: { main: 'src/main.ts' },
    format: ['esm'],
    target: 'node22',
    clean: true,
    sourcemap: true,
});
