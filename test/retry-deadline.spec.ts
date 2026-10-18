import { describe, expect, it } from 'vitest';

import { TOOLS } from '../src/tools/index.js';

// mcp#57: one name, two meanings. /v1/access calls `retry_deadline` the last
// moment a retry is taken; the merchant API calls that `retry_closes_at`, and
// its `retry_deadline` is the end of the missed period, two minutes later. An
// agent quoting the latter tells the merchant a deadline already past.

/** Every description of a property named `name` anywhere in a tool's output. */
function descriptionsOf(tool: string, name: string): string[] {
    const found: string[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const properties = (node as { properties?: Record<string, { description?: string }> })
            .properties;
        if (properties?.[name]) found.push(properties[name].description ?? '');
        for (const child of Object.values(node)) walk(child);
    };
    walk(TOOLS.find((t) => t.name === tool)!.outputSchema.toJSONSchema());
    return found;
}

describe('the retry deadline an agent quotes', () => {
    it.each(['get_subscription', 'list_subscriptions'])(
        'is retry_closes_at in %s, and retry_deadline says it is not',
        (tool) => {
            const closes = descriptionsOf(tool, 'retry_closes_at');
            expect(closes.length).toBeGreaterThan(0);
            for (const text of closes) expect(text).toMatch(/Quote this one as the deadline/);
            for (const text of descriptionsOf(tool, 'retry_deadline'))
                expect(text).toMatch(/Not the deadline to quote/);
        },
    );

    it('is retry_deadline in check_access', () => {
        const deadline = descriptionsOf('check_access', 'retry_deadline');
        expect(deadline.length).toBeGreaterThan(0);
        for (const text of deadline) expect(text).toMatch(/The deadline to quote/);
    });
});
