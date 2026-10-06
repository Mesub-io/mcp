import { inspect } from 'node:util';

import { clientAddress } from '../src/client-address.js';
import { RefusedTokens, WindowLimiter } from '../src/rate-limit.js';

describe('WindowLimiter', () => {
    const make = (options: { limit?: number; maxKeys?: number } = {}) => {
        const clock = { now: 0 };
        const limiter = new WindowLimiter({
            limit: options.limit ?? 3,
            windowMs: 60_000,
            maxKeys: options.maxKeys ?? 100,
            now: () => clock.now,
        });
        return { clock, limiter };
    };

    it('lets the limit through, then refuses with the seconds left', () => {
        const { clock, limiter } = make();

        for (let i = 0; i < 3; i++) expect(limiter.take('a').ok).toBe(true);
        clock.now = 12_500;
        expect(limiter.take('a')).toMatchObject({ ok: false, retryAfterSeconds: 48 });
        expect(limiter.take('b').ok).toBe(true);
    });

    it('starts again when the window has passed, and not before', () => {
        const { clock, limiter } = make();
        for (let i = 0; i < 3; i++) limiter.take('a');

        clock.now = 59_999;
        expect(limiter.take('a')).toMatchObject({ ok: false, retryAfterSeconds: 1 });
        clock.now = 60_000;
        expect(limiter.take('a').ok).toBe(true);
    });

    it('gives back what is refunded, once, and only inside its window', () => {
        const { clock, limiter } = make({ limit: 1 });

        const first = limiter.take('a');
        expect(limiter.take('a').ok).toBe(false);
        if (first.ok) {
            first.refund();
            first.refund();
        }
        expect(limiter.take('a').ok).toBe(true);
        expect(limiter.take('a').ok).toBe(false);

        // A refund that comes after the window it was taken in changes nothing.
        clock.now = 60_000;
        const second = limiter.take('a');
        clock.now = 120_000;
        const third = limiter.take('a');
        if (second.ok) second.refund();
        expect(third.ok).toBe(true);
        expect(limiter.take('a').ok).toBe(false);
    });

    it('says once per window that a key went over', () => {
        const { limiter } = make({ limit: 1 });
        limiter.take('a');
        expect(limiter.take('a')).toMatchObject({ ok: false, first: true });
        expect(limiter.take('a')).toMatchObject({ ok: false, first: false });
    });

    it('never holds more keys than it may: past that, strangers share one budget', () => {
        const { clock, limiter } = make({ limit: 2, maxKeys: 3 });

        for (const key of ['a', 'b', 'c']) expect(limiter.take(key).ok).toBe(true);
        expect(limiter.size).toBe(3);

        // Two more strangers fit in the shared budget, the third does not.
        expect(limiter.take('d').ok).toBe(true);
        expect(limiter.take('e').ok).toBe(true);
        expect(limiter.take('f').ok).toBe(false);
        expect(limiter.size).toBeLessThanOrEqual(4);
        // A key already known keeps its own budget.
        expect(limiter.take('a').ok).toBe(true);

        // Once the windows have passed, the room is found again.
        clock.now = 60_000;
        expect(limiter.take('f').ok).toBe(true);
        expect(limiter.size).toBeLessThanOrEqual(3);
    });
});

describe('RefusedTokens', () => {
    const make = (max = 3) => {
        const clock = { now: 0 };
        const refused = new RefusedTokens({ ttlMs: 1000, max, now: () => clock.now });
        return { clock, refused };
    };

    it('remembers a token until its time is up', () => {
        const { clock, refused } = make();
        refused.add('mat_a');

        expect(refused.has('mat_a')).toBe(true);
        expect(refused.has('mat_b')).toBe(false);
        clock.now = 999;
        expect(refused.has('mat_a')).toBe(true);
        clock.now = 1000;
        expect(refused.has('mat_a')).toBe(false);
        expect(refused.size).toBe(0);
    });

    it('never holds more than its bound: the oldest goes first', () => {
        const { refused } = make(3);
        for (const token of ['mat_a', 'mat_b', 'mat_c', 'mat_d', 'mat_e']) refused.add(token);

        expect(refused.size).toBe(3);
        expect(refused.has('mat_a')).toBe(false);
        expect(refused.has('mat_b')).toBe(false);
        expect(refused.has('mat_e')).toBe(true);
    });

    it('drops what has run out before anything still fresh', () => {
        const { clock, refused } = make(2);
        refused.add('mat_a');
        clock.now = 600;
        refused.add('mat_b');
        clock.now = 1000;
        refused.add('mat_c');

        expect(refused.has('mat_b')).toBe(true);
        expect(refused.has('mat_c')).toBe(true);
        expect(refused.size).toBe(2);
    });

    it('does not keep the tokens themselves', () => {
        const { refused } = make();
        refused.add('mat_a-token-nobody-should-keep');

        expect(inspect(refused, { depth: 5, showHidden: true })).not.toContain(
            'nobody-should-keep',
        );
        expect(JSON.stringify(refused)).not.toContain('nobody-should-keep');
    });
});

describe('clientAddress', () => {
    const headers = (values: Record<string, string> = {}) => new Headers(values);

    it('is the socket peer when no header is configured, whatever the request claims', () => {
        const forged = headers({
            'x-forwarded-for': '9.9.9.9',
            'cf-connecting-ip': '9.9.9.9',
            'fly-client-ip': '9.9.9.9',
            'x-real-ip': '9.9.9.9',
            forwarded: 'for=9.9.9.9',
        });
        expect(clientAddress('203.0.113.7', forged, undefined)).toBe('203.0.113.7');
    });

    it('is the configured header when it holds one address', () => {
        expect(
            clientAddress(
                '10.0.0.1',
                headers({ 'fly-client-ip': '198.51.100.4' }),
                'fly-client-ip',
            ),
        ).toBe('198.51.100.4');
        expect(
            clientAddress(
                '10.0.0.1',
                headers({ 'cf-connecting-ip': ' 198.51.100.4 ' }),
                'cf-connecting-ip',
            ),
        ).toBe('198.51.100.4');
    });

    it.each([
        ['missing', {}],
        ['empty', { 'fly-client-ip': '' }],
        ['two addresses', { 'fly-client-ip': '198.51.100.4, 198.51.100.5' }],
        ['not an address', { 'fly-client-ip': 'localhost' }],
        ['an address and more', { 'fly-client-ip': '198.51.100.4\tx' }],
    ])('falls back on the peer when the header is %s', (_case, values) => {
        expect(clientAddress('10.0.0.1', headers(values), 'fly-client-ip')).toBe('10.0.0.1');
    });

    it("counts a client's IPv6 address by its /64, and the peer whole", () => {
        const one = headers({ 'fly-client-ip': '2001:db8:1:2:aaaa::1' });
        const other = headers({ 'fly-client-ip': '2001:DB8:1:2:bbbb::2' });

        expect(clientAddress('10.0.0.1', one, 'fly-client-ip')).toBe('2001:db8:1:2::/64');
        expect(clientAddress('10.0.0.1', other, 'fly-client-ip')).toBe('2001:db8:1:2::/64');
        expect(clientAddress('2001:db8:1:2:aaaa::1', headers(), undefined)).toBe(
            '2001:db8:1:2:aaaa:0:0:1',
        );
    });

    it('reads an IPv4 address shown as IPv6 as the IPv4 it is', () => {
        expect(clientAddress('::ffff:203.0.113.7', headers(), undefined)).toBe('203.0.113.7');
        expect(clientAddress('::ffff:cb00:7107', headers(), undefined)).toBe('203.0.113.7');
    });

    it('does not believe the edge header on a request the platform proxy forwarded', () => {
        const both = headers({ 'cf-connecting-ip': '9.9.9.9', 'fly-client-ip': '198.51.100.4' });
        expect(clientAddress('10.0.0.1', both, 'cf-connecting-ip')).toBe('10.0.0.1');
    });

    it('puts every request without a usable peer in one bucket', () => {
        expect(clientAddress(undefined, headers(), undefined)).toBe('unknown');
        expect(clientAddress('not an address', headers(), undefined)).toBe('unknown');
    });
});
