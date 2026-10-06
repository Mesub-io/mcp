/** What an amount is counted in: the symbol when Mesub vouches for the mint, else the mint. */
export interface AmountUnit {
    symbol?: string | null;
    mint: string | null;
}

const WHOLE = /^\d+$/;
/** What a decimal library writes past twenty-one digits: `1.5e+21`. */
const EXPONENT = /^(\d)(?:\.(\d+))?[eE]\+(\d{1,3})$/;
/** Past any real mint, and what keeps a padded string small. */
const MAX_DECIMALS = 36;
/** Past any sum of u64 amounts. */
const MAX_DIGITS = 80;
const U64_MAX = 18446744073709551615n;

/**
 * The digits of an amount in the smallest unit, as the API serves one: a
 * whole number, or the same written with an exponent. Null for anything
 * else: a fraction of a unit is not an amount.
 */
function wholeDigits(amount: string): string | null {
    if (WHOLE.test(amount)) return amount.length <= MAX_DIGITS ? amount : null;

    const [, lead, fraction = '', exponent] = EXPONENT.exec(amount) ?? [];
    if (lead === undefined || exponent === undefined) return null;
    const zeros = Number(exponent) - fraction.length;
    if (zeros < 0 || Number(exponent) >= MAX_DIGITS) return null;
    return lead + fraction + '0'.repeat(zeros);
}

/**
 * An amount as a person reads it, for a model to quote without arithmetic:
 * "9.99 USDC". Exact, on the digits themselves: never through a float.
 *
 * Only when the mint's decimals are known. Unknown, the raw amount and the
 * mint are shown and the text says so: a guess would be a wrong price. An
 * amount that is not a whole number of units is shown as it came, and said so.
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

    const token = mint === null ? 'an unknown token' : `mint ${mint}`;
    const known =
        decimals !== null &&
        Number.isInteger(decimals) &&
        decimals >= 0 &&
        decimals <= MAX_DECIMALS;
    if (!known) return `${amount} in the smallest unit of ${token} (decimals unknown)`;

    const whole = wholeDigits(amount);
    if (whole === null) {
        return `${amount} as Mesub served it, not a whole number of the smallest unit of ${token}`;
    }

    // BigInt drops leading zeros and nothing else.
    const digits = BigInt(whole)
        .toString()
        .padStart(decimals + 1, '0');
    const units = digits.slice(0, digits.length - decimals);
    const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
    const number = fraction === '' ? units : `${units}.${fraction}`;

    if (symbol) return `${number} ${symbol}`;
    return mint === null ? number : `${number} of mint ${mint}`;
}

/** A price as a person writes one: digits, and a fraction after a point. Nothing else. */
const PRICE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * A price a person wrote ("9.99") in the smallest unit of a token of
 * `decimals` decimals ("9990000"), on the digits and never through a float.
 * Null rather than a rounding or a guess: a sign, an exponent, a comma, more
 * decimals than the token has, or more than a u64 holds.
 */
export function toSmallestUnit(price: string, decimals: number): string | null {
    const [, units, fraction = ''] = PRICE.exec(price) ?? [];
    if (units === undefined || units.length > MAX_DIGITS) return null;
    if (fraction.length > decimals || (fraction === '' && price.includes('.'))) return null;

    const amount = BigInt(units + fraction.padEnd(decimals, '0'));
    return amount <= U64_MAX ? amount.toString() : null;
}
