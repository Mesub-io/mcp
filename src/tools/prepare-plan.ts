import * as z from 'zod';

import { MesubApiError } from '../mesub/errors.js';
import type { PreparedPlan } from '../mesub/schemas.js';
import { DATA_NOTICE, quoted } from '../text.js';
import { toSmallestUnit } from './money.js';
import { ToolRefusal } from './result.js';
import { planOut, planOutput } from './shapes.js';
import { defineTool } from './tool.js';
import { TOKEN_SYMBOLS, TOKENS } from './tokens.js';
import {
    MAX_RETRY_ATTEMPTS,
    MAX_RETRY_DELAY_MINUTES,
    MIN_RETRY_DELAY_MINUTES,
} from './update-retry-policy.js';

export const MAX_PLAN_NAME_LENGTH = 16;
export const MAX_PLAN_DESCRIPTION_LENGTH = 280;
export const MAX_WEBSITE_URL_LENGTH = 512;
export const MAX_PERIOD_HOURS = 8760;

// A control character but a line break, or a character that shows as nothing or turns the text around.
const HIDDEN =
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Whether a name gives a slug, as the API derives one: two letters or digits at least, one a letter. */
function givesSlug(name: string): boolean {
    const plain = name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    return plain.length >= 2 && /[a-z]/.test(plain);
}

/** Https, no credentials, no space: what can be told without fetching it. Nothing here does. */
function plainHttps(value: string): boolean {
    if (/[\s\\]/.test(value) || !URL.canParse(value)) return false;
    const { protocol, username, password } = new URL(value);
    return protocol === 'https:' && username === '' && password === '';
}

/** "9WzD...AWWM", or nothing for what is not an address. */
function shortAddress(address: string): string | null {
    return BASE58_ADDRESS.test(address) ? `${address.slice(0, 4)}...${address.slice(-4)}` : null;
}

/**
 * What of the plan Mesub answered is not what was asked, in a merchant's
 * words. The plan exists by then, and its merchant will sign what they did
 * not type: one that differs is never presented as the one asked for.
 */
function differences(
    plan: PreparedPlan,
    asked: { mint: string; amount: string; decimals: number; symbol: string; periodHours: number },
): string[] {
    const differs: string[] = [];
    if (plan.amount !== asked.amount) differs.push('price');
    if (
        plan.mint !== asked.mint ||
        plan.symbol !== asked.symbol ||
        plan.decimals !== asked.decimals
    ) {
        differs.push('token');
    }
    if (plan.periodHours !== asked.periodHours) differs.push('period');
    if (plan.endsAt !== null) differs.push('end date');
    if (plan.status !== 'PENDING') differs.push('state');
    return differs;
}

export const preparePlan = defineTool({
    name: 'prepare_plan',
    title: 'Prepare a plan to sign',
    description:
        'Prepare a subscription plan for the merchant to sign: its name, its price, its token ' +
        'and how often it charges. Use it when the merchant asks for a new plan, once they ' +
        'have given the name, the price, the token and the period: ask for any of these that ' +
        'is missing, and never guess one. It creates nothing on chain and charges nobody: ' +
        'the plan waits in the dashboard, where nobody can subscribe to it, until the ' +
        'merchant opens the link this returns, reviews the plan and signs it with their own ' +
        'wallet. The plan does not exist for subscribers before that, so never say it was ' +
        'created or published. It always pays the wallet the merchant connected to Mesub, ' +
        'and it can never set an end date, a receiver, a slug (it comes from the name) or ' +
        'another token than the ones listed: those are done by the merchant in the dashboard. ' +
        'It publishes, edits, closes and deletes nothing, and no tool here does: a prepared ' +
        'plan holds one of the plan places of the tier until the merchant signs or deletes ' +
        'it. The price is given as a person writes it ("9.99"), never in a smallest unit. ' +
        'Repeat the name, the price and the period to the merchant as the result states ' +
        'them, and give them the link. To change the retries of a plan that exists use ' +
        '`update_retry_policy`; to see the plans and the names in use, `list_plans`.',
    inputSchema: z
        .strictObject({
            name: z
                .string()
                .min(1)
                .max(MAX_PLAN_NAME_LENGTH)
                .refine((name) => /^[\p{Script=Latin}0-9 .&'-]+$/u.test(name.normalize('NFC')), {
                    message: "Letters, digits, spaces and - ' . & only.",
                })
                .refine((name) => name === name.trim() && !name.includes('  '), {
                    message: 'No space at either end, and no two spaces in a row.',
                })
                .refine(givesSlug, {
                    message: 'Two letters or digits at least, one of them a letter.',
                })
                .describe(
                    `What subscribers read, 1 to ${MAX_PLAN_NAME_LENGTH} characters: Latin ` +
                        "letters, digits, single spaces and the marks - ' . & with two letters " +
                        'or digits at least. Not the name of another plan of the project.',
                ),
            token: z
                .enum(TOKEN_SYMBOLS)
                .describe(
                    `The token subscribers pay in: ${TOKEN_SYMBOLS.join(', ')}. Its symbol, ` +
                        'never an address. Ask the merchant when they did not name one.',
                ),
            price: z
                .string()
                .max(40)
                .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'A plain decimal such as "9.99".')
                .describe(
                    'What one period costs, in the token, as a person writes it and as a ' +
                        'string: "9.99", "10", "0.5". A point for the decimals, six of them at ' +
                        'most, no sign, no thousands separator, no currency. Never an amount ' +
                        'in the smallest unit: "9990000" is nine million nine hundred ninety ' +
                        'thousand.',
                ),
            period_hours: z
                .number()
                .int()
                .min(1)
                .max(MAX_PERIOD_HOURS)
                .describe(
                    `How often subscribers are charged, in whole hours, 1 to ${MAX_PERIOD_HOURS}: ` +
                        '24 a day, 168 a week, 720 a month (30 days, not a calendar month), ' +
                        '8760 a year (365 days).',
                ),
            description: z
                .string()
                .max(MAX_PLAN_DESCRIPTION_LENGTH)
                .refine((value) => !HIDDEN.test(value), {
                    message: 'No control or invisible character but a line break.',
                })
                .optional()
                .describe(
                    `What the plan gives, shown to subscribers, ${MAX_PLAN_DESCRIPTION_LENGTH} ` +
                        'characters at most.',
                ),
            website_url: z
                .string()
                .max(MAX_WEBSITE_URL_LENGTH)
                .refine(plainHttps, { message: 'An https URL, without a user name or a password.' })
                .optional()
                .describe(
                    "The merchant's site, https, where a subscriber checks who they pay. Only " +
                        'one the merchant gave.',
                ),
            retry_attempts: z
                .number()
                .int()
                .min(1)
                .max(MAX_RETRY_ATTEMPTS)
                .optional()
                .describe(
                    `How many retries a failed charge gets, 1 to ${MAX_RETRY_ATTEMPTS}. With ` +
                        '`retry_delay_minutes`, or left out with it for the built in policy. ' +
                        'Refused on a tier that does not retry.',
                ),
            retry_delay_minutes: z
                .number()
                .int()
                .min(MIN_RETRY_DELAY_MINUTES)
                .max(MAX_RETRY_DELAY_MINUTES)
                .optional()
                .describe(
                    `Minutes between two tries, ${MIN_RETRY_DELAY_MINUTES} at least. With ` +
                        '`retry_attempts`, or left out with it.',
                ),
        })
        .refine((args) => toSmallestUnit(args.price, TOKENS[args.token].decimals) !== null, {
            path: ['price'],
            message: 'More decimals than the token has, or more than a plan can charge.',
        })
        .refine(
            (args) =>
                (args.retry_attempts === undefined) === (args.retry_delay_minutes === undefined),
            {
                path: ['retry_attempts'],
                message: 'Send both retry_attempts and retry_delay_minutes, or neither.',
            },
        ),
    outputSchema: z.object({
        plan: planOutput.describe(
            'The plan as Mesub holds it: PENDING, not on chain. Quote `amount_display` and ' +
                '`period_display`.',
        ),
        sign_url: z
            .string()
            .describe(
                'The page of the dashboard where the merchant reviews this plan and signs it. ' +
                    'Give it to them as it is.',
            ),
        next_step: z.string().describe('What Mesub says comes next, to relay.'),
    }),
    annotations: {
        readOnlyHint: false,
        // It adds a draft and overwrites nothing: its merchant deletes it in the dashboard.
        destructiveHint: false,
        // A second call is a second plan, or a refusal for the name.
        idempotentHint: false,
        // Nothing leaves Mesub: no chain, no endpoint, until the merchant signs.
        openWorldHint: false,
    },
    handler: async (args, { mesub, signal }) => {
        const token = TOKENS[args.token];
        const amount = toSmallestUnit(args.price, token.decimals);
        // The input schema refused it already.
        if (amount === null) throw new ToolRefusal('invalid_request', 'The price cannot be read.');

        let plan: PreparedPlan | undefined;
        let sent = '';
        let refusal: MesubApiError | undefined;
        // One address of the token per network Mesub runs on, and the API takes
        // one: it refuses the others before it writes anything. Any other
        // failure ends the call, since the plan may then exist.
        for (const mint of token.mints) {
            try {
                plan = await mesub.preparePlan(
                    {
                        name: args.name,
                        mint,
                        amount,
                        periodHours: args.period_hours,
                        description: args.description,
                        websiteUrl: args.website_url,
                        retryAttempts: args.retry_attempts,
                        retryDelayMinutes: args.retry_delay_minutes,
                    },
                    signal,
                );
                sent = mint;
                break;
            } catch (error) {
                if (!(error instanceof MesubApiError) || error.code !== 'mint_not_allowed') {
                    throw error;
                }
                refusal = error;
            }
        }
        if (plan === undefined) {
            throw refusal ?? new ToolRefusal('internal_error', 'No address for that token.');
        }

        const differs = differences(plan, {
            mint: sent,
            amount,
            decimals: token.decimals,
            symbol: args.token,
            periodHours: args.period_hours,
        });
        if (differs.length > 0) {
            // Never the plan nor its link: what came back is not what was asked.
            throw new ToolRefusal(
                'prepared_plan_mismatch',
                `Mesub prepared a plan that is not the one asked for: its ${differs.join(', its ')} ` +
                    'differ. Tell the merchant not to sign it and to delete it in the ' +
                    'dashboard, under Plans. Do not prepare it again before they have.',
            );
        }

        const shown = planOut(plan);
        const wallet = shortAddress(plan.receiver);
        return {
            data: { plan: shown, sign_url: plan.signUrl, next_step: plan.nextStep },
            // From what Mesub answered, never from the arguments: it is what will be signed.
            text:
                `Prepared, NOT published: plan ${plan.name === null ? 'without a name' : quoted(plan.name)} ` +
                `at ${shown.amount_display} ${shown.period_display}, paid to the merchant's own ` +
                `wallet${wallet === null ? '' : ` ${wallet}`}, with no end date. Nothing is on ` +
                'chain: nobody can subscribe or be charged until the merchant opens ' +
                // The address stands alone, so that nothing after it is read as part of it.
                `${plan.signUrl} , reviews the plan and signs it with their wallet. Give them ` +
                `that link and repeat the name, the price and the period to them. ${DATA_NOTICE}`,
        };
    },
});
