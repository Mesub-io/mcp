/** What an amount is counted in: the symbol when Mesub vouches for the mint, else the mint. */
export interface AmountUnit {
    symbol?: string | null;
    mint: string | null;
}

const WHOLE = /^\d+$/;
/** Past any real mint, and what keeps a padded string small. */
const MAX_DECIMALS = 36;

/**
 * An amount as a person reads it, for a model to quote without arithmetic:
 * "9.99 USDC". Exact, on the digits themselves: never through a float.
 *
 * Only when the mint's decimals are known. Unknown, the raw amount and the
 * mint are shown and the text says so: a guess would be a wrong price.
 */
export function displayAmount(amount: string, decimals: number | null, unit: AmountUnit): string;
export function displayAmount(
    amount: string | null,
    decimals: number | null,
    unit: AmountUnit,
): string | null;
export function displayAmount(
    amount: string | null,
    decimals: number | null,
    { symbol, mint }: AmountUnit,
): string | null {
    if (amount === null) return null;

    const known =
        decimals !== null &&
        Number.isInteger(decimals) &&
        decimals >= 0 &&
        decimals <= MAX_DECIMALS &&
        WHOLE.test(amount);
    if (!known) {
        const token = mint === null ? 'an unknown token' : `mint ${mint}`;
        return `${amount} in the smallest unit of ${token} (decimals unknown)`;
    }

    // BigInt drops leading zeros and nothing else.
    const digits = BigInt(amount)
        .toString()
        .padStart(decimals + 1, '0');
    const whole = digits.slice(0, digits.length - decimals);
    const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
    const number = fraction === '' ? whole : `${whole}.${fraction}`;

    if (symbol) return `${number} ${symbol}`;
    return mint === null ? number : `${number} of mint ${mint}`;
}
