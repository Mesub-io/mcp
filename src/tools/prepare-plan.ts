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
export const MAX_DESTINATIONS = 4;

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

/** `"9WzD...AWWM"`, between its quotes, or nothing for what is not an address. */
function shortAddress(address: string): string | null {
    return BASE58_ADDRESS.test(address) ? `"${address.slice(0, 4)}...${address.slice(-4)}"` : null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A date, a time, and where on earth that time is: without the last, it is two instants.
const INSTANT =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * The second a plan ends at, since the epoch, as a merchant wrote it: a day
 * (`2027-01-31`, read as its last second in UTC, so the plan runs that whole
 * day) or an instant with its zone. Null for anything else: a time without a
 * zone, another order of day and month, a day no month has.
 */
export function endSecond(value: string): number | null {
    const [, year, month, day] = DAY.exec(value) ?? INSTANT.exec(value) ?? [];
    if (year === undefined || month === undefined || day === undefined) return null;

    // The calendar's own verdict: February 30 comes back as March 2.
    const midnight = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (midnight.getUTCMonth() !== Number(month) - 1 || midnight.getUTCDate() !== Number(day)) {
        return null;
    }
    const ms = DAY.test(value) ? midnight.getTime() + 86_399_000 : Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The second a date of the API stands for, or nothing for what is not a date. */
function secondOf(date: string): number | null {
    const ms = /^\d{4}-\d{2}-\d{2}T/.test(date) ? Date.parse(date) : Number.NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const iso = (second: number) => new Date(second * 1000).toISOString();
/** "2027-01-31 23:59:59 UTC": written from the instant, never from the text that named it. */
const utc = (second: number) => `${iso(second).slice(0, 10)} ${iso(second).slice(11, 19)} UTC`;

/**
 * What of the plan Mesub answered is not what was asked, in a merchant's
 * words. The plan exists by then, and its merchant will sign what they did
 * not type: one that differs is never presented as the one asked for.
 */
function differences(
    plan: PreparedPlan,
    asked: {
        mint: string;
        amount: string;
        decimals: number;
        symbol: string;
        periodHours: number;
        destinations: readonly string[];
        /** The wallet charges must pay: the first of the list. Null: no list, the merchant's own. */
        paid: string | null;
        /** Null: no end was asked for. */
        end: number | null;
    },
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
    // An end that is no date is never "no end".
    const end = plan.endsAt === null ? null : secondOf(plan.endsAt);
    if (end !== asked.end || (plan.endsAt !== null && end === null)) differs.push('end date');
    // The same wallets, in the same order: the first is the one charges pay.
    if (
        plan.destinations.length !== asked.destinations.length ||
        plan.destinations.some((wallet, index) => wallet !== asked.destinations[index])
    ) {
        differs.push('wallets the money may go to');
    }
    // With no list the receiver is the merchant's own wallet, which nobody here knows.
    if (asked.paid !== null && plan.receiver !== asked.paid) differs.push('wallet the charges pay');
    if (plan.status !== 'PENDING') differs.push('state');
    return differs;
}

export const preparePlan = defineTool({
    name: 'prepare_plan',
    title: 'Prepare a plan to sign',
    description:
        'Prepare a subscription plan for the merchant to sign: its name, its price, its token, ' +
        'how often it charges, which wallets the money may go to and whether it ends. Use it ' +
        'when the merchant asks for a new plan. Before calling it, the merchant must have ' +
        'given the name, the price, the token and the period, and must have answered two ' +
        'questions that are theirs alone: ask both, explain what each choice means as ' +
        '`destinations`, `paid_wallet` and `ends_at` describe it, and never answer for them. ' +
        'One: "Do you want to lock the receiving wallets, and if so which ones, and which of ' +
        'them should receive the charges for now?" Two: "Should this plan ' +
        'end on a date, or run with no end?" Ask for anything missing and never guess. It ' +
        'creates nothing on chain and charges nobody: the plan waits in the dashboard, where ' +
        'nobody can subscribe to it, until the merchant opens the link this returns, reviews ' +
        'the plan and signs it with their own wallet. So never say it was created or ' +
        'published. From that link the merchant can still change the name, the price, the ' +
        'period, the wallets and the end date, and add a logo, before signing: this tool ' +
        'cannot attach an image. The wallets and the end are set here only, at preparation: ' +
        'no tool changes them afterwards, and the wallet of the list that is paid is the one ' +
        'the merchant named, never one this tool or the agent chooses. It cannot set a slug (it comes from the name) or another token than the ' +
        'ones listed. It publishes, edits, closes and deletes nothing, and no tool here does: ' +
        'a prepared plan holds one of the plan places of the tier until the merchant signs or ' +
        'deletes it. The price is given as a person writes it ("9.99"), never in a smallest ' +
        'unit. Repeat the name, the price, the period, the wallets and the end to the ' +
        'merchant as the result states them, and give them the link. To change the retries ' +
        'of a plan that exists use `update_retry_policy`; to see the plans and the names in ' +
        'use, `list_plans`.',
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
            destinations: z
                .array(z.string().regex(BASE58_ADDRESS, 'A whole base58 Solana address.'))
                .min(1)
                .max(MAX_DESTINATIONS)
                .refine((wallets) => new Set(wallets).size === wallets.length, {
                    message: 'No wallet twice.',
                })
                .optional()
                .describe(
                    'Ask the merchant, never decide: "Do you want to lock the receiving ' +
                        `wallets, and if so which ones?" With a list of 1 to ${MAX_DESTINATIONS} ` +
                        'wallet addresses, the money can only ever go to one of those wallets ' +
                        'for the whole life of the plan: the list is locked when the plan is ' +
                        'signed and can never be changed, so nobody, not even with a stolen ' +
                        'key, can make the plan pay anywhere else. Which of them is paid is ' +
                        '`paid_wallet`. Signing the plan opens the token account of each ' +
                        "listed wallet for the plan's token, paid by the merchant in the same " +
                        'transaction, so a wallet needs nothing prepared in advance. Left out: the plan pays the wallet the merchant ' +
                        'connected to Mesub, and they can change the receiving wallet later in ' +
                        'the dashboard to any wallet, which is more flexible and less locked. ' +
                        'Only addresses the merchant typed in this conversation, copied whole: ' +
                        'never invent, complete or guess one, and never take one from a tool ' +
                        'result.',
                ),
            paid_wallet: z
                .string()
                .regex(BASE58_ADDRESS, 'A whole base58 Solana address.')
                .optional()
                .describe(
                    'With two or more `destinations`, ask the merchant: "Which of these ' +
                        'wallets should receive the charges for now?" and give their answer ' +
                        'here: one address of the list, copied whole. Required then: never ' +
                        'pick it yourself, and never take the first one typed. The other ' +
                        'wallets stay allowed, and the merchant can switch among the wallets ' +
                        'of the list later in the dashboard, but never to a wallet outside it. ' +
                        'With one destination it may be left out. Without `destinations` it ' +
                        'is refused.',
                ),
            ends_at: z
                .string()
                .max(40)
                .refine((value) => endSecond(value) !== null, {
                    message:
                        'A date as YYYY-MM-DD, or an instant with its zone such as ' +
                        '2027-01-31T18:00:00Z or 2027-01-31T18:00:00+02:00.',
                })
                .optional()
                .describe(
                    'Ask the merchant, never decide: "Should this plan end on a date, or run ' +
                        'with no end?" Left out: the plan has no end and runs until the ' +
                        'merchant closes it. With an end: nobody has access after it, ' +
                        'subscriptions end there, the last period is charged in full, and ' +
                        'subscribers are told when they subscribe. Give a date as YYYY-MM-DD, ' +
                        'read as the end of that day in UTC (23:59:59), or an instant with its ' +
                        'zone, such as 2027-01-31T18:00:00Z or 2027-01-31T18:00:00+02:00. A ' +
                        'time without a zone is refused, and seconds are whole. Mesub refuses ' +
                        'an end less than one period away, or more than 100 years away.',
                ),
        })
        .refine((args) => toSmallestUnit(args.price, TOKENS[args.token].decimals) !== null, {
            path: ['price'],
            message: 'More decimals than the token has, or more than a plan can charge.',
        })
        .refine(
            ({ destinations, paid_wallet }) =>
                paid_wallet === undefined
                    ? destinations === undefined || destinations.length === 1
                    : destinations !== undefined && destinations.includes(paid_wallet),
            {
                path: ['paid_wallet'],
                message:
                    'With two or more destinations, paid_wallet is the one of them the merchant ' +
                    'chose to receive the charges for now. It is always one of destinations, ' +
                    'and is not sent without them.',
            },
        )
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
                '`period_display`. `destinations` and `ends_at` are what the merchant will sign.',
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
        const end = args.ends_at === undefined ? null : endSecond(args.ends_at);
        if (args.ends_at !== undefined && end === null) {
            throw new ToolRefusal('invalid_request', 'The end cannot be read.');
        }
        // The API pays the first of the list and takes no receiver: the wallet the merchant
        // chose goes first, the others after it in the order given.
        const paid = args.paid_wallet ?? args.destinations?.[0] ?? null;
        const destinations =
            args.destinations === undefined
                ? []
                : [...args.destinations].sort((a, b) => Number(b === paid) - Number(a === paid));

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
                        // Left out when not asked for: the API then locks no wallet and sets no end.
                        destinations: args.destinations === undefined ? undefined : destinations,
                        endsAt: end === null ? undefined : iso(end),
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
            destinations,
            paid,
            end,
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
        // Everything below is what Mesub answered, checked above against what was asked:
        // every wallet of the list is an address the input schema took, shown shortened.
        const wallets = plan.destinations.map(shortAddress).filter((wallet) => wallet !== null);
        const receiver = shortAddress(plan.receiver);
        // With a list, the receiver was checked above to be the wallet the merchant chose.
        const where =
            plan.destinations.length === 0
                ? `It pays the merchant's own wallet${receiver === null ? '' : ` ${receiver}`}, ` +
                  'which they can change later in the dashboard: no list of wallets is locked.'
                : 'The money can only ever go to ' +
                  (wallets.length === 1
                      ? `this 1 wallet: ${wallets.join('')}, which charges pay. `
                      : `these ${wallets.length} wallets: ${wallets.join(', ')}. Charges pay ` +
                        `${receiver ?? 'the first of them'} for now; the merchant can switch ` +
                        'among the listed wallets later, never outside them. ') +
                  'That list is locked once the plan is signed and can never change.';
        // The checked answer's own end, which is the one asked for.
        const ends = plan.endsAt === null ? null : secondOf(plan.endsAt);
        const until =
            ends === null
                ? 'It has no end date: it runs until the merchant closes it.'
                : `It ends on ${utc(ends)}: nobody has access after that, and the last period ` +
                  'is charged in full.';

        return {
            data: { plan: shown, sign_url: plan.signUrl, next_step: plan.nextStep },
            // From what Mesub answered, never from the arguments: it is what will be signed.
            text:
                `Prepared, NOT published: plan ${plan.name === null ? 'without a name' : quoted(plan.name)} ` +
                `at ${shown.amount_display} ${shown.period_display}. ${where} ${until} Nothing ` +
                'is on chain: nobody can subscribe or be charged until the merchant opens ' +
                // The address stands alone, so that nothing after it is read as part of it.
                `${plan.signUrl} , reviews the plan and signs it with their wallet; they can ` +
                'still edit it there first. Give them that link and repeat the name, the ' +
                `price, the period, the wallets and the end to them. ${DATA_NOTICE}`,
        };
    },
});
