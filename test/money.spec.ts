import { displayAmount } from '../src/tools/money.js';
import { snake } from '../src/tools/snake.js';
import { clip, TRUNCATED } from '../src/text.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('displayAmount', () => {
    it.each([
        ['0', '0 USDC'],
        ['1', '0.000001 USDC'],
        ['9990000', '9.99 USDC'],
        ['1000000', '1 USDC'],
        ['12345678901234567890', '12345678901234.56789 USDC'],
        ['100000000000000000000', '100000000000000 USDC'],
    ])('shows %s at 6 decimals as %s, exactly', (amount, shown) => {
        expect(displayAmount(amount, 6, { symbol: 'USDC', mint: MINT })).toBe(shown);
    });

    it('needs no decimal point at zero decimals', () => {
        expect(displayAmount('42', 0, { symbol: 'USDC', mint: MINT })).toBe('42 USDC');
    });

    it('names the mint when the decimals are known and the symbol is not', () => {
        expect(displayAmount('9990000', 6, { mint: MINT })).toBe(`9.99 of mint ${MINT}`);
        expect(displayAmount('9990000', 6, { symbol: null, mint: MINT })).toBe(
            `9.99 of mint ${MINT}`,
        );
    });

    it('shows the raw amount and the mint, and says so, when the decimals are unknown', () => {
        expect(displayAmount('9990000', null, { symbol: 'USDC', mint: MINT })).toBe(
            `9990000 in the smallest unit of mint ${MINT} (decimals unknown)`,
        );
        expect(displayAmount('9990000', null, { mint: null })).toBe(
            '9990000 in the smallest unit of an unknown token (decimals unknown)',
        );
    });

    it('never guesses at an amount that is not a whole number of units', () => {
        for (const amount of ['1e+21', '9.99', '-5', '', ' 12']) {
            expect(displayAmount(amount, 6, { symbol: 'USDC', mint: MINT })).toBe(
                `${amount} in the smallest unit of mint ${MINT} (decimals unknown)`,
            );
        }
    });

    it('is null for no amount', () => {
        expect(displayAmount(null, 6, { symbol: 'USDC', mint: MINT })).toBeNull();
    });

    it('goes through no float: a value past 2^53 keeps every digit', () => {
        expect(displayAmount('9007199254740993', 6, { symbol: 'USDT', mint: MINT })).toBe(
            '9007199254.740993 USDT',
        );
    });
});

describe('clip', () => {
    it('leaves a text within the bound as it is', () => {
        expect(clip('hello', 5)).toBe('hello');
    });

    it('cuts a longer one and marks it', () => {
        expect(clip('x'.repeat(50), 10)).toBe('x'.repeat(10) + TRUNCATED);
    });
});

describe('snake', () => {
    it('renames camelCase keys at every depth and leaves the values alone', () => {
        expect(
            snake({
                planId: 'p',
                collectedThisPeriodUsd: '1.00',
                retryPolicy: { honoured: true, reasonGiven: null },
                rows: [{ failedPulls: 2, lastPaidAt: 'someDate' }],
            }),
        ).toEqual({
            plan_id: 'p',
            collected_this_period_usd: '1.00',
            retry_policy: { honoured: true, reason_given: null },
            rows: [{ failed_pulls: 2, last_paid_at: 'someDate' }],
        });
    });

    it('leaves alone a key that is a status, not a field name', () => {
        expect(snake({ byStatus: { ACTIVE: 3, UNPAID: 1 } })).toEqual({
            by_status: { ACTIVE: 3, UNPAID: 1 },
        });
    });
});
