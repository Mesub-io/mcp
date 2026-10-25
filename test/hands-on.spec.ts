import type { Client } from '@modelcontextprotocol/client';

import { INSTRUCTIONS } from '../src/server.js';
import { TOOLS } from '../src/tools/index.js';
import * as answers from './fixtures/agent-answers.js';
import {
    EXTERNAL_ID,
    PLAN_ID,
    PREPARED_ID,
    RECEIVER,
    SIGNATURE,
    SITE,
    WALLET,
} from './fixtures/agent-answers.js';
import { connect, fakeMesubApi, startServer, type FakeApi, type TestServer } from './helpers.js';

// What an assistant ran into when it used these tools against the real stack (#40).

type Result = Awaited<ReturnType<Client['callTool']>>;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Data = any;

const text = (result: Result) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
const sentence = (result: Result) => text(result).split('\n')[0] ?? '';
const SIGN_URL = `${SITE}/dashboard#plans/publish/${PREPARED_ID}`;

describe('what a hands-on run found', () => {
    let api: FakeApi;
    let server: TestServer;
    let client: Client;

    beforeAll(async () => {
        api = await fakeMesubApi();
        server = await startServer(
            { MESUB_API_URL: api.url },
            { limits: { perConnection: 100_000 } },
        );
        client = await connect(server.url, { modern: true });
        await client.listTools();
    });
    afterAll(async () => {
        await client.close();
        await server.stop();
        await api.close();
    });
    beforeEach(() => {
        api.calls.length = 0;
    });

    const call = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });
    const description = (name: string) => TOOLS.find((tool) => tool.name === name)!.description;

    describe('the external id, never the email', () => {
        it('is on every subscription a tool returns, and no email is', async () => {
            const reads: [string, Record<string, unknown>, unknown][] = [
                ['list_subscriptions', {}, answers.subscriptionPage],
                ['get_subscription', { subscription_id: answers.row.id }, answers.subscription],
                ['get_plan', { plan_id: PLAN_ID }, answers.planDetail],
                ['get_overview', {}, answers.overview],
                ['list_events', { day: '2026-10-01' }, answers.eventLines],
                ['list_upcoming_charges', {}, answers.atRiskUpcoming],
            ];
            for (const [tool, args, answer] of reads) {
                api.answer(200, answer);
                const result = await call(tool, args);
                const said = JSON.stringify(result.structuredContent);

                expect(said, tool).toContain(`"external_id":${JSON.stringify(EXTERNAL_ID)}`);
                expect(said, tool).not.toMatch(/"email"|must_not_leak/);
                expect(text(result), tool).not.toMatch(/must_not_leak/);
            }
        });

        it('is passed on as `q`, for the API to match its start', async () => {
            for (const tool of ['list_subscriptions', 'list_upcoming_charges', 'list_events']) {
                api.calls.length = 0;
                api.answer(
                    200,
                    tool === 'list_subscriptions'
                        ? answers.subscriptionPage
                        : tool === 'list_events'
                          ? answers.eventDays
                          : answers.upcoming,
                );
                await call(tool, { q: 'cus_42' });

                expect(api.projectCalls()[0]?.query, tool).toMatchObject({ q: 'cus_42' });
            }
        });

        it('takes a search as long as the longest external id', async () => {
            api.answer(200, answers.subscriptionPage);
            const long = 'c'.repeat(255);

            await call('list_subscriptions', { q: long });

            expect(api.projectCalls()[0]?.query).toMatchObject({ q: long });
        });

        it('passes the start of a signature on as it is', async () => {
            api.answer(200, answers.eventDays);

            await call('list_events', { q: SIGNATURE.slice(0, 8) });

            expect(api.projectCalls()[0]?.query).toMatchObject({ q: SIGNATURE.slice(0, 8) });
        });

        it('refuses an answer whose external id is longer than the API takes', async () => {
            api.answer(200, {
                ...answers.subscriptionPage,
                rows: [{ ...answers.row, externalId: 'x'.repeat(256) }],
            });

            const result = await call('list_subscriptions');

            expect(text(result)).toMatch(/^Mesub error unexpected/);
        });
    });

    describe('the upcoming charges sure to fail', () => {
        it('counts a revoked approval and a block, not a balance a top up fixes', async () => {
            api.answer(200, answers.atRiskUpcoming);

            const result = await call('list_upcoming_charges');
            const { upcoming } = result.structuredContent as Data;

            expect(upcoming.map((line: Data) => [line.kind, line.expected_to_fail])).toEqual([
                ['retry', true],
                ['charge', true],
                ['retry', false],
                ['charge', false],
            ]);
            expect(upcoming[0]).toMatchObject({
                late_reason: 'APPROVAL_REVOKED',
                blocked_since: null,
                blocked_reason: null,
            });
            expect(upcoming[1]).toMatchObject({
                late_reason: null,
                blocked_since: '2026-10-01T12:00:00.000Z',
                blocked_reason: 'receiver_account_missing',
            });
            expect(sentence(result)).toMatch(
                /^4 lines scheduled: 2 retry, 2 charge\. 2 charges expected to fail \(`expected_to_fail`\): 1 a retry after a revoked approval or a closed authority, 1 blocked, not by the subscriber\./,
            );
        });

        it('never counts an end, whatever it carries', async () => {
            api.answer(200, [{ ...answers.atRiskUpcoming[1], kind: 'ends' }]);

            const result = await call('list_upcoming_charges');

            expect((result.structuredContent as Data).upcoming[0].expected_to_fail).toBe(false);
            expect(sentence(result)).toMatch(/0 charges expected to fail\./);
        });
    });

    describe('the link to sign a prepared plan', () => {
        const pending = { ...answers.preparedPlan, ...answers.plans[0], signUrl: SIGN_URL };

        it('comes back with a PENDING plan in the list and in the plan, null otherwise', async () => {
            api.answer(200, [
                { ...pending, id: PREPARED_ID, status: 'PENDING' },
                { ...answers.plans[0], signUrl: null },
                // From an API older than the field.
                answers.plans[1],
            ]);
            const listed = await call('list_plans');
            const { plans } = listed.structuredContent as Data;

            expect(plans.map((plan: Data) => plan.sign_url)).toEqual([SIGN_URL, null, null]);
            expect(sentence(listed)).toMatch(/A plan waiting in To sign carries `sign_url`/);
            // The merchant's words for the state, never the code.
            expect(sentence(listed)).toMatch(/^3 plans: 2 ACTIVE, 1 waiting in To sign\./);

            api.answer(200, {
                ...answers.planDetail,
                plan: { ...answers.plan, id: PREPARED_ID, status: 'PENDING', signUrl: SIGN_URL },
            });
            const one = await call('get_plan', { plan_id: PREPARED_ID });

            expect((one.structuredContent as Data).plan.sign_url).toBe(SIGN_URL);
            expect(sentence(one)).toContain(`signs it at ${SIGN_URL} .`);
            expect(sentence(one)).toMatch(/^The plan is waiting in To sign, with/);

            api.answer(200, answers.planDetail);
            const signed = await call('get_plan', { plan_id: PLAN_ID });
            expect((signed.structuredContent as Data).plan.sign_url).toBeNull();
            expect(sentence(signed)).not.toMatch(/signs it at/);
        });

        it('refuses an answer whose link is not an address of the dashboard', async () => {
            api.answer(200, [{ ...pending, signUrl: 'javascript:alert(1)' }]);

            expect(text(await call('list_plans'))).toMatch(/^Mesub error unexpected/);
        });
    });

    describe('the overview', () => {
        it('says how many charges are not priced, and what a null recovery rate means', async () => {
            api.answer(200, {
                ...answers.overview,
                overview: {
                    ...answers.overview.overview,
                    totals: {
                        ...answers.overview.overview.totals,
                        current: { ...answers.overview.overview.totals.current, unpriced: 6 },
                    },
                },
                collection: { ...answers.overview.collection, recoveryRate: null },
            });

            const result = await call('get_overview');

            expect(sentence(result)).toMatch(
                /2 failed, 0 won back by a retry, 6 not priced in dollars \(the dollar figures leave them out\)/,
            );
            expect((result.structuredContent as Data).collection.recovery_rate).toBeNull();
            const schema = JSON.stringify(
                TOOLS.find((t) => t.name === 'get_overview')!.outputSchema.toJSONSchema(),
            );
            expect(schema).toMatch(/what failed is not priced/);
            expect(schema).toMatch(/one per subscriber and period/);
        });
    });

    describe('what a tool says it did', () => {
        it('says a rename leaves the name on chain until the merchant signs', async () => {
            api.answer(200, answers.servedProject);

            const result = await call('update_project', { name: 'Fraise' });

            expect(sentence(result)).toMatch(
                /Plans already published keep the old name on chain until the merchant signs an update of each in the dashboard/,
            );
        });

        it('has the merchant say which wallet is paid, never the agent', async () => {
            const result = await call('prepare_plan', {
                name: 'Pro',
                token: 'USDC',
                price: '9.99',
                period_hours: 720,
                destinations: [WALLET, RECEIVER],
            });

            expect(text(result)).toMatch(
                /Ask the merchant which of their wallets is paid for now, then call again: never pick one yourself/,
            );
            expect(api.projectCalls()).toHaveLength(0);
        });

        it('says where to find the project, and to name it in every change', () => {
            expect(INSTRUCTIONS).toMatch(
                /Call `list_projects` when you do not know\s+which project/,
            );
            expect(INSTRUCTIONS).not.toMatch(/`list_projects` first/);
            expect(INSTRUCTIONS).toMatch(/Name the project in every tool that changes something/);
            expect(INSTRUCTIONS).toMatch(/relay it, never retry it/);
            expect(description('get_project')).toContain('`list_projects`');
        });
    });
});
