/**
 * The tokens an agent may prepare a plan in: the ones Mesub vouches for, a
 * closed list the Mesub API holds too and checks every time.
 *
 * A token has one number of decimals wherever it lives, which is what lets a
 * price be written exactly without asking anything. It has one address per
 * network Mesub runs on, and a deployment takes exactly one network: on the
 * test network only USDC exists. No route says which network a deployment
 * runs on, so this server learns it from the first address the API takes
 * (`learnNetwork`), and until then offers the addresses in this order, the
 * main network first. The API refuses the others before it
 * writes anything (`mint_not_allowed`).
 *
 * A token the API adds is not offered until it is added here, and one it
 * drops is refused by the API: either way no plan is prepared in a token
 * this table gets wrong.
 */
export const TOKENS = {
    USDC: {
        decimals: 6,
        mints: [
            { network: 'mainnet', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
            { network: 'devnet', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
        ],
    },
    USDT: {
        decimals: 6,
        mints: [{ network: 'mainnet', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }],
    },
    PYUSD: {
        decimals: 6,
        mints: [{ network: 'mainnet', mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' }],
    },
} as const satisfies Record<
    string,
    { decimals: number; mints: readonly [TokenMint, ...TokenMint[]] }
>;

export type Network = 'mainnet' | 'devnet';
interface TokenMint {
    network: Network;
    mint: string;
}

export type TokenSymbol = keyof typeof TOKENS;
export const TOKEN_SYMBOLS = Object.keys(TOKENS) as [TokenSymbol, ...TokenSymbol[]];

/** The network the API this process talks to runs on, once an answer said it. */
let learned: Network | null = null;

/** The addresses of a token to send, in order: those of the network learned, else all. */
export function mintsToTry(symbol: TokenSymbol): readonly TokenMint[] {
    const mints: readonly TokenMint[] = TOKENS[symbol].mints;
    return learned === null ? mints : mints.filter((mint) => mint.network === learned);
}

/** The tokens the network learned has, all of them while none is. */
export function tokensHere(): TokenSymbol[] {
    return TOKEN_SYMBOLS.filter((symbol) => mintsToTry(symbol).length > 0);
}

/** The network learned, null while none is. */
export function networkLearned(): Network | null {
    return learned;
}

/**
 * An address the API took is of its network. A refusal teaches nothing: the
 * API may have dropped that one token, and the others of the network stand.
 */
export function learnNetwork(mint: TokenMint): void {
    learned = mint.network;
}

/** Forget the network: every address of the network learned was refused, or for the tests. */
export function forgetNetwork(): void {
    learned = null;
}
