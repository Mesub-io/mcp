/**
 * The tokens an agent may prepare a plan in: the ones Mesub vouches for, a
 * closed list the Mesub API holds too and checks every time.
 *
 * A token has one number of decimals wherever it lives, which is what lets a
 * price be written exactly without asking anything. It has one address per
 * network Mesub runs on, and a deployment takes exactly one of them: this
 * server does not know which, so `prepare_plan` offers them in this order,
 * the address of the public deployment first. The API refuses the others
 * before it writes anything (`mint_not_allowed`).
 *
 * A token the API adds is not offered until it is added here, and one it
 * drops is refused by the API: either way no plan is prepared in a token
 * this table gets wrong.
 */
export const TOKENS = {
    USDC: {
        decimals: 6,
        mints: [
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        ],
    },
    USDT: { decimals: 6, mints: ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'] },
    PYUSD: { decimals: 6, mints: ['2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'] },
} as const satisfies Record<string, { decimals: number; mints: readonly [string, ...string[]] }>;

export type TokenSymbol = keyof typeof TOKENS;
export const TOKEN_SYMBOLS = Object.keys(TOKENS) as [TokenSymbol, ...TokenSymbol[]];
