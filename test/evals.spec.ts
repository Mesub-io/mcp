import { readFileSync } from 'node:fs';

import { INSTRUCTIONS } from '../src/server.js';
import { TOOLS } from '../src/tools/index.js';

// What can be checked of the tool layer without a model: that the tools can
// be told apart by their descriptions, and that the scenarios in evals/ are
// about the tools the server has. Running the scenarios against a model is
// done by hand: see evals/README.md.

interface Scenario {
    id: string;
    kind: 'choose' | 'ask_first' | 'refuse' | 'injection';
    prompt: string;
    /** What a tool returned earlier in the conversation, for an injection. */
    injected?: { tool: string; field: string; text: string };
    expect: {
        /** The tools a good agent calls, in order. Empty: none. */
        calls: string[];
        /** The tools it must not call. */
        never: string[];
        /** It asks the merchant, and waits, before the first call that changes something. */
        ask_first: boolean;
        says: string;
    };
}

const scenarios = JSON.parse(
    readFileSync(new URL('../evals/scenarios.json', import.meta.url), 'utf8'),
) as Scenario[];

const names = TOOLS.map((tool) => tool.name);
const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
const description = (name: string): string => byName.get(name)?.description ?? '';
/** Up to the first full stop or colon: what an agent reads first. */
const firstSentence = (text: string) => text.split(/(?<=[.:])\s/)[0] ?? '';

/** Two tools an agent could take for one another: the first must send to the second by name. */
const CONFUSABLE: [string, string][] = [
    ['list_plans', 'get_plan'],
    ['get_plan', 'list_plans'],
    ['list_plans', 'prepare_plan'],
    ['get_project', 'list_plans'],
    ['get_project', 'get_overview'],
    ['list_subscriptions', 'get_subscription'],
    ['get_subscription', 'list_subscriptions'],
    ['list_subscriptions', 'check_access'],
    ['check_access', 'list_subscriptions'],
    ['list_events', 'list_upcoming_charges'],
    ['list_upcoming_charges', 'list_events'],
    ['list_events', 'get_overview'],
    ['get_overview', 'list_events'],
    ['retry_charge', 'update_retry_policy'],
    ['update_retry_policy', 'retry_charge'],
    ['update_retry_policy', 'prepare_plan'],
    ['prepare_plan', 'update_retry_policy'],
    ['prepare_plan', 'list_plans'],
    ['create_webhook', 'update_webhook'],
    ['update_webhook', 'create_webhook'],
    ['update_webhook', 'delete_webhook'],
    ['delete_webhook', 'update_webhook'],
    ['get_webhook_secret', 'regenerate_webhook_secret'],
    ['regenerate_webhook_secret', 'get_webhook_secret'],
    ['list_webhooks', 'list_webhook_deliveries'],
    ['list_webhook_deliveries', 'list_webhooks'],
    ['list_webhook_deliveries', 'list_events'],
    ['send_test_webhook', 'list_webhook_deliveries'],
    ['update_project', 'get_project'],
    ['ping', 'get_project'],
];

/** What Mesub removed, or never gave an agent: no description may promise it. */
const REMOVED = [
    /allowed origins?/i,
    /\bresend/i,
    /\bhour(ly)? cap\b|this hour|per hour|an hour\b.*\bchanges/i,
    /publishable key/i,
    /secret key/i,
    /agent_write_cap/i,
    /\/v1\/client/i,
    /devnet|mainnet/i,
    /—/,
];

describe('the descriptions an agent chooses from', () => {
    it('open with a sentence no other tool opens with', () => {
        const openings = TOOLS.map((tool) => firstSentence(tool.description));

        expect(new Set(openings).size).toBe(TOOLS.length);
        for (const opening of openings) {
            expect(opening.length, opening).toBeGreaterThan(25);
            expect(opening.length, opening).toBeLessThan(260);
        }
    });

    it('open with a verb, in the words of a merchant, and never with the name of the tool', () => {
        for (const tool of TOOLS) {
            expect(tool.description, tool.name).toMatch(/^[A-Z][a-z]+ /);
            expect(firstSentence(tool.description), tool.name).not.toContain(tool.name);
            expect(firstSentence(tool.description), tool.name).not.toMatch(
                /\/agent|endpoint of the API|HTTP/,
            );
        }
    });

    it('are long enough to choose from and short enough to read among 23', () => {
        for (const tool of TOOLS) {
            expect(tool.description.length, tool.name).toBeGreaterThan(200);
            expect(tool.description.length, tool.name).toBeLessThan(1500);
            expect(tool.title.length, tool.name).toBeLessThan(50);
        }
        const all = TOOLS.reduce((sum, tool) => sum + tool.description.length, 0);
        expect(all).toBeLessThan(18_000);
    });

    it('have a title no other tool has', () => {
        expect(new Set(TOOLS.map((tool) => tool.title)).size).toBe(TOOLS.length);
    });

    it.each(CONFUSABLE)('%s says to use %s for what it is not for', (tool, sibling) => {
        expect(names).toContain(tool);
        expect(names).toContain(sibling);
        expect(description(tool)).toContain(`\`${sibling}\``);
    });

    it('name only tools that exist', () => {
        for (const tool of TOOLS) {
            const named = [...tool.description.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(
                (match) => match[1] ?? '',
            );
            for (const name of named) {
                // An argument or a field of a result is not a tool: only verbs first.
                if (
                    !/^(list|get|create|update|delete|check|send|prepare|regenerate|search)_/.test(
                        name,
                    )
                )
                    continue;
                expect(names, `${tool.name} names ${name}`).toContain(name);
            }
        }
    });

    it('say whether they change anything, each of them', () => {
        for (const tool of TOOLS) {
            if (tool.annotations.readOnlyHint) {
                expect(tool.description, tool.name).toMatch(
                    /[Cc]hanges nothing|changes nothing|charges nothing|reads nothing|lands in this conversation/,
                );
            }
            if (tool.annotations.destructiveHint) {
                expect(tool.description, tool.name).toMatch(/[Aa]sk the merchant|replaces|cannot/);
            }
        }
    });

    it('promise nothing Mesub removed or never gave an agent', () => {
        const texts = [
            INSTRUCTIONS,
            ...TOOLS.flatMap((tool) => [
                tool.title,
                tool.description,
                JSON.stringify(tool.inputSchema.toJSONSchema?.() ?? {}),
                JSON.stringify(tool.outputSchema.toJSONSchema?.() ?? {}),
            ]),
        ];
        for (const text of texts) {
            for (const removed of REMOVED) expect(text).not.toMatch(removed);
        }
    });

    it('are counted right by the instructions every client reads', () => {
        expect(INSTRUCTIONS).toContain(`${TOOLS.length} tools`);
        expect(INSTRUCTIONS).toMatch(/`prepare_plan`/);
        expect(INSTRUCTIONS).toMatch(/nothing is on chain/i);
        expect(INSTRUCTIONS).toMatch(/UNKNOWN/);
    });
});

describe('the scenarios in evals/', () => {
    it('are well formed, each under its own id', () => {
        expect(scenarios.length).toBeGreaterThan(40);
        expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
        for (const scenario of scenarios) {
            expect(scenario.id).toMatch(/^[a-z0-9-]+$/);
            expect(['choose', 'ask_first', 'refuse', 'injection']).toContain(scenario.kind);
            expect(scenario.prompt.length, scenario.id).toBeGreaterThan(8);
            expect(scenario.expect.says.length, scenario.id).toBeGreaterThan(8);
            expect(typeof scenario.expect.ask_first, scenario.id).toBe('boolean');
            // No em dash, here as everywhere.
            expect(JSON.stringify(scenario), scenario.id).not.toMatch(/—/);
        }
    });

    it('name only tools the server has, and never expect a call they forbid', () => {
        for (const scenario of scenarios) {
            for (const tool of [...scenario.expect.calls, ...scenario.expect.never]) {
                expect(names, `${scenario.id}: ${tool}`).toContain(tool);
            }
            for (const tool of scenario.expect.calls) {
                expect(scenario.expect.never, scenario.id).not.toContain(tool);
            }
        }
    });

    it('expect every tool at least once, first in line at least once', () => {
        const first = new Set(scenarios.map((scenario) => scenario.expect.calls[0]));
        for (const name of names) expect([...first], name).toContain(name);
    });

    it('have a near miss for every pair of tools that can be confused', () => {
        const pairs = new Set(CONFUSABLE.map(([a, b]) => [a, b].sort().join(' / ')));
        for (const pair of pairs) {
            const [a = '', b = ''] = pair.split(' / ');
            const covered = scenarios.some(
                ({ expect: wanted }) =>
                    (wanted.calls.includes(a) && wanted.never.includes(b)) ||
                    (wanted.calls.includes(b) && wanted.never.includes(a)),
            );
            expect(covered, pair).toBe(true);
        }
    });

    it('ask first before every call the server marks destructive', () => {
        for (const scenario of scenarios) {
            const destructive = scenario.expect.calls.some(
                (name) => byName.get(name)?.annotations.destructiveHint,
            );
            if (destructive) expect(scenario.expect.ask_first, scenario.id).toBe(true);
        }
    });

    it('call nothing that changes anything where the agent must refuse', () => {
        const refusals = scenarios.filter((scenario) => scenario.kind === 'refuse');

        expect(refusals.length).toBeGreaterThan(7);
        for (const scenario of refusals) {
            for (const name of scenario.expect.calls) {
                expect(byName.get(name)?.annotations.readOnlyHint, scenario.id).toBe(true);
            }
        }
        // What an agent can never do, each asked for once.
        const asked = refusals.map((scenario) => scenario.prompt).join('\n');
        for (const never of [
            /API key/,
            /tier|Business/,
            /[Dd]elete .*plan/,
            /[Rr]esend/,
            /end date|ends on/,
        ]) {
            expect(asked).toMatch(never);
        }
    });

    it('put an injected instruction in a field somebody else writes, and forbid what it asks for', () => {
        const injections = scenarios.filter((scenario) => scenario.kind === 'injection');

        expect(injections.length).toBeGreaterThan(5);
        for (const scenario of injections) {
            expect(scenario.injected, scenario.id).toBeDefined();
            expect(names, scenario.id).toContain(scenario.injected?.tool);
            expect(scenario.injected?.text.length, scenario.id).toBeGreaterThan(10);
            expect(scenario.expect.never.length, scenario.id).toBeGreaterThan(0);
        }
        const fields = injections.map((scenario) => scenario.injected?.field).join(' ');
        expect(fields).toMatch(/name/);
        expect(fields).toMatch(/external_id/);
    });

    it('never have prepare_plan given a raw amount, an address or an end', () => {
        const preparing = scenarios.filter((scenario) =>
            scenario.expect.calls.includes('prepare_plan'),
        );

        expect(preparing.length).toBeGreaterThan(3);
        for (const scenario of preparing) {
            expect(scenario.expect.says, scenario.id).not.toMatch(/9990000|10000000/);
        }
    });
});
