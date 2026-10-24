import type { Client } from '@modelcontextprotocol/client';

import { ERROR_META_KEY, ROLE_ADVICE } from '../src/tools/result.js';
import { forgetNetwork } from '../src/tools/tokens.js';
import { POISON, refusal, SITE, WEBHOOK_ID } from './fixtures/agent-answers.js';
import { connect, fakeMesubApi, startServer, type FakeApi, type TestServer } from './helpers.js';
import { CASES } from './tool-cases.js';

type Result = Awaited<ReturnType<Client['callTool']>>;

const text = (result: Result) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
const errorOf = (result: Result) =>
    result._meta?.[ERROR_META_KEY] as
        | { code: string; message: string; status: number | null; walletUrl?: string | null }
        | undefined;

const PRO = { name: 'Pro', token: 'USDC', price: '9.99', period_hours: 720 };
const ROLE = 'Only the Owner and Admins can manage webhooks.';
const NO_TEAM_WALLET =
    'Fraise has no team wallet yet. The Owner sets one in Organization settings.';
const TEAM_WALLET_URL = `${SITE}/dashboard#settings`;

describe('the refusals of an organization', () => {
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
    });
    afterAll(async () => {
        await client.close();
        await server.stop();
        await api.close();
    });
    beforeEach(() => {
        api.calls.length = 0;
        forgetNetwork();
    });

    const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });

    it('passes role_required through verbatim and says who can do it', async () => {
        api.answer(403, refusal(403, 'role_required', ROLE));

        for (const entry of CASES) {
            const result = await call(entry.tool, entry.args);

            expect(result.isError, entry.tool).toBe(true);
            expect(text(result), entry.tool).toMatch(
                new RegExp(`^Mesub error role_required: ${ROLE.replace(/\./g, '\\.')} `),
            );
            expect(text(result), entry.tool).toContain(ROLE_ADVICE);
            expect(text(result), entry.tool).not.toMatch(/connect again|delete a plan/);
            expect(errorOf(result), entry.tool).toMatchObject({
                code: 'role_required',
                status: 403,
            });
        }
        expect(ROLE_ADVICE).not.toMatch(/connect again/i);
        // Only the Owner changes a role (member.promote is Owner-only).
        expect(ROLE_ADVICE).toContain('the Owner can make them an Admin');
        expect(ROLE_ADVICE).not.toMatch(/admins? can (give|grant|change|make)/i);
        expect(ROLE_ADVICE).not.toMatch(/give them that role/i);
    });

    it('relays the team wallet link on team_wallet_required', async () => {
        api.answer(409, {
            ...refusal(409, 'team_wallet_required', NO_TEAM_WALLET),
            walletUrl: TEAM_WALLET_URL,
        });

        const result = await call('prepare_plan', PRO);

        expect(result.isError).toBe(true);
        expect(text(result)).toBe(
            `Mesub error team_wallet_required: ${NO_TEAM_WALLET} Nothing was prepared. This ` +
                'organization has no team wallet yet, and only its Owner sets one, at ' +
                `${TEAM_WALLET_URL} , then call again.`,
        );
        // The address alone between " at " and " ,": nothing after it reads as part of it.
        expect(text(result)).toContain(` at ${TEAM_WALLET_URL} ,`);
        expect(errorOf(result)).toMatchObject({
            code: 'team_wallet_required',
            status: 409,
            walletUrl: TEAM_WALLET_URL,
        });
        expect(api.projectCalls()).toHaveLength(1);
    });

    it('says where to look when team_wallet_required carries no link', async () => {
        api.answer(409, refusal(409, 'team_wallet_required', NO_TEAM_WALLET));

        const result = await call('prepare_plan', PRO);

        expect(text(result)).toBe(
            `Mesub error team_wallet_required: ${NO_TEAM_WALLET} Nothing was prepared. This ` +
                'organization has no team wallet yet, and only its Owner sets one, in the ' +
                'Organization settings of the Mesub dashboard, then call again.',
        );
        expect(errorOf(result)?.walletUrl ?? null).toBeNull();
    });

    it('refuses a walletUrl that is not a link of the dashboard', async () => {
        for (const walletUrl of [
            'javascript:alert(1)',
            `${TEAM_WALLET_URL} ${POISON}`,
            'https://user:pass@mesub.io/dashboard#settings',
            POISON,
            { href: TEAM_WALLET_URL },
        ]) {
            api.answer(409, {
                ...refusal(409, 'team_wallet_required', NO_TEAM_WALLET),
                walletUrl,
            });

            const result = await call('prepare_plan', PRO);

            expect(text(result), String(walletUrl)).toContain(
                'in the Organization settings of the Mesub dashboard, then call again.',
            );
            expect(JSON.stringify(result), String(walletUrl)).not.toContain(POISON);
            expect(JSON.stringify(result), String(walletUrl)).not.toContain('javascript:');
            expect(JSON.stringify(result), String(walletUrl)).not.toContain('user:pass');
        }
    });

    it.each([
        [
            400,
            'project_required',
            'This connection reaches every project of the organization: name one.',
            'Call `list_projects`, ask the merchant which project when it is not clear, then ' +
                'call again with `project`.',
        ],
        [
            404,
            'project_not_found',
            'No project of this organization has that id or name.',
            'Take the project from `list_projects`: its id or its exact name.',
        ],
        [
            400,
            'project_ambiguous',
            'Two projects of this organization answer to that name.',
            "Call again with the project's id from `list_projects`.",
        ],
        [
            403,
            'project_outside_pin',
            'This connection reaches one project of the organization.',
            'This connection reaches one project. For another, the merchant connects again and ' +
                'chooses the whole organization or that project.',
        ],
    ])('advises each project code: %i %s', async (status, code, message, advice) => {
        api.answer(status, refusal(status, code, message));

        for (const tool of ['list_plans', 'create_webhook', 'prepare_plan']) {
            const args = CASES.find((entry) => entry.tool === tool)?.args ?? {};
            const result = await call(tool, args);

            expect(text(result), tool).toBe(`Mesub error ${code}: ${message} ${advice}`);
            expect(errorOf(result), tool).toMatchObject({ code, status });
        }
    });

    it('an unknown 409 code passes through verbatim', async () => {
        const message = 'That action was prepared already.';
        api.answer(409, refusal(409, 'already_prepared', message));

        const result = await call('update_webhook', { webhook_id: WEBHOOK_ID, enabled: false });

        expect(text(result)).toBe(
            `Mesub error already_prepared: ${message} Refused in the current state, and ` +
                'nothing was changed: read it again before deciding.',
        );
        expect(errorOf(result)).toMatchObject({ code: 'already_prepared', status: 409 });
        expect(errorOf(result)).not.toHaveProperty('walletUrl');
    });

    it('gives prepare_plan the slug advice for a bare conflict only', async () => {
        const message = 'That action was prepared already.';
        api.answer(409, refusal(409, 'already_prepared', message));

        const result = await call('prepare_plan', PRO);

        expect(text(result)).toBe(
            `Mesub error already_prepared: ${message} Refused in the current state, and ` +
                'nothing was changed: read it again before deciding.',
        );
        expect(text(result)).not.toMatch(/slug/);
    });
});
