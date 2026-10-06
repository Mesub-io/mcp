import { inspect } from 'node:util';

import { clientAddress, proxyList, type ClientAddressSource } from '../src/client-address.js';
import { CheckLane, KnownTokens, RefusedTokens, WindowLimiter } from '../src/rate-limit.js';

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

    it('H3: never holds more keys than it may, and never makes strangers share a budget', () => {
        const { clock, limiter } = make({ limit: 2, maxKeys: 3 });

        for (const key of ['a', 'b', 'c']) expect(limiter.take(key).ok).toBe(true);
        limiter.take('a');
        expect(limiter.take('a').ok).toBe(false);
        expect(limiter.size).toBe(3);

        // Any number of strangers each get a budget of their own.
        for (let i = 0; i < 100; i++) {
            expect(limiter.take(`stranger-${i}`).ok).toBe(true);
            expect(limiter.take(`stranger-${i}`).ok).toBe(true);
            expect(limiter.size).toBeLessThanOrEqual(3);
        }
        // What it costs: the keys dropped to make room start afresh. A limit evaded, nobody kept out.
        expect(limiter.take('a').ok).toBe(true);
        expect(limiter.dropped).toBeGreaterThan(90);

        clock.now = 60_000;
        expect(limiter.take('z').ok).toBe(true);
    });

    it('drops windows that ended before any still running, then the least recently used', () => {
        const { clock, limiter } = make({ limit: 1, maxKeys: 3 });

        limiter.take('old');
        clock.now = 30_000;
        limiter.take('b');
        limiter.take('c');
        clock.now = 60_000;
        // `old` has ended: it goes, and nothing still counting is touched.
        limiter.take('d');
        expect(limiter.dropped).toBe(0);
        expect(limiter.take('b').ok).toBe(false);
        expect(limiter.take('c').ok).toBe(false);

        // Nothing has ended now: the least recently used goes, which is `d`.
        limiter.take('e');
        expect(limiter.dropped).toBe(1);
        expect(limiter.take('b').ok).toBe(false);
        expect(limiter.take('c').ok).toBe(false);
        expect(limiter.take('e').ok).toBe(false);
    });
});

describe('KnownTokens', () => {
    const make = (max = 3) => {
        const clock = { now: 0 };
        const known = new KnownTokens({ max, now: () => clock.now });
        return { clock, known };
    };

    it('remembers which connection a token was accepted for, until the token expires', () => {
        const { clock, known } = make();
        known.add('mat_a', 'conn_a', 5000);

        expect(known.connectionOf('mat_a')).toBe('conn_a');
        expect(known.connectionOf('mat_b')).toBeUndefined();
        clock.now = 4999;
        expect(known.connectionOf('mat_a')).toBe('conn_a');
        clock.now = 5000;
        expect(known.connectionOf('mat_a')).toBeUndefined();
        expect(known.size).toBe(0);
    });

    it('forgets a token on demand, and the least recently used past its bound', () => {
        const { known } = make(2);
        known.add('mat_a', 'conn_a', 1000);
        known.add('mat_b', 'conn_b', 1000);
        known.connectionOf('mat_a');
        known.add('mat_c', 'conn_c', 1000);

        expect(known.size).toBe(2);
        expect(known.connectionOf('mat_b')).toBeUndefined();
        expect(known.connectionOf('mat_a')).toBe('conn_a');

        known.delete('mat_a');
        expect(known.connectionOf('mat_a')).toBeUndefined();
    });

    it('does not keep the tokens themselves', () => {
        const { known } = make();
        known.add('mat_a-token-nobody-should-keep', 'conn_a', 1000);
        expect(inspect(known, { depth: 5, showHidden: true })).not.toContain('nobody-should-keep');
        expect(JSON.stringify(known)).not.toContain('nobody-should-keep');
    });
});

describe('CheckLane', () => {
    const make = (options: Partial<ConstructorParameters<typeof CheckLane>[0]> = {}) =>
        new CheckLane({
            perAddress: 2,
            total: 3,
            waitingPerAddress: 2,
            waitingTotal: 4,
            maxWaitMs: 1000,
            ...options,
        });
    const settled = async <T>(promise: Promise<T>): Promise<T | 'pending'> =>
        Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 10))]);

    it('lets in as many per address as it may, and makes the next wait for a place', async () => {
        const lane = make();
        const one = await lane.enter('a', 'k1');
        const two = await lane.enter('a', 'k2');
        const three = lane.enter('a', 'k3');

        expect(one && two).toBeTruthy();
        expect(await settled(three)).toBe('pending');
        expect(lane.running).toBe(2);
        expect(lane.waiting).toBe(1);

        one?.leave();
        expect(await three).toBeTruthy();
        expect(lane.waiting).toBe(0);
    });

    it('sheds at once past the room to wait in, per address and in all', async () => {
        const lane = make({ perAddress: 1, total: 10 });
        await lane.enter('a', 'k');
        void lane.enter('a', 'k');
        void lane.enter('a', 'k');
        expect(await lane.enter('a', 'k')).toBeUndefined();

        await lane.enter('b', 'k');
        void lane.enter('b', 'k');
        void lane.enter('b', 'k');
        await lane.enter('c', 'k');
        // Four wait in all now: no more room, whatever the address.
        expect(lane.waiting).toBe(4);
        expect(await lane.enter('c', 'k')).toBeUndefined();
    });

    it('shares the room to wait in: whoever filled it gives a place up to a newcomer', async () => {
        const lane = make({ perAddress: 1, total: 1, waitingPerAddress: 10, waitingTotal: 4 });
        await lane.enter('flood', 'k');
        const flood = Array.from({ length: 4 }, () => lane.enter('flood', 'k'));
        expect(lane.waiting).toBe(4);

        // No room: the flood's last comer is shed, not the stranger.
        const quiet = lane.enter('quiet', 'k');
        expect(await flood[3]).toBeUndefined();
        expect(await settled(quiet)).toBe('pending');
        const other = lane.enter('other', 'k');
        expect(await flood[2]).toBeUndefined();
        expect(lane.waiting).toBe(4);

        const third = lane.enter('third', 'k');
        expect(await flood[1]).toBeUndefined();
        for (const waiting of [quiet, other, third, ...flood.slice(0, 1)]) {
            expect(await settled(waiting)).toBe('pending');
        }

        // Once nobody takes more than anybody else, a newcomer is the one shed.
        expect(await lane.enter('fourth', 'k')).toBeUndefined();
        expect(lane.waiting).toBe(4);
    });

    it('sheds a wait that lasted too long, and one whose caller left', async () => {
        const lane = make({ perAddress: 1, maxWaitMs: 30 });
        const first = await lane.enter('a', 'k');
        expect(await lane.enter('a', 'k')).toBeUndefined();
        expect(lane.waiting).toBe(0);

        const gone = new AbortController();
        const waiting = lane.enter('a', 'k', gone.signal);
        gone.abort();
        expect(await waiting).toBeUndefined();
        expect(lane.waiting).toBe(0);

        first?.leave();
        expect(lane.running).toBe(0);
        expect(lane.addresses).toBe(0);
    });

    it('serves addresses in turns: one cannot take every place of the instance', async () => {
        const lane = make({ perAddress: 3, total: 3, waitingPerAddress: 50, waitingTotal: 100 });
        const held = [await lane.enter('flood', 'k'), await lane.enter('flood', 'k')];
        held.push(await lane.enter('flood', 'k'));
        const order: string[] = [];
        const wait = (address: string) =>
            lane.enter(address, 'k').then((pass) => {
                order.push(address);
                return pass;
            });

        const flood = Array.from({ length: 20 }, () => wait('flood'));
        const quiet = wait('quiet');
        const other = wait('other');

        held[0]?.leave();
        held[1]?.leave();
        held[2]?.leave();
        await Promise.all([quiet, other]);

        // Three places freed: one each, not three for whoever came first.
        expect(order.slice(0, 3).sort()).toEqual(['flood', 'other', 'quiet']);
        void flood;
    });

    it('lets everybody waiting on one key through when told the key is good', async () => {
        const lane = make({ perAddress: 1, total: 1, waitingPerAddress: 10, waitingTotal: 10 });
        const first = await lane.enter('a', 'good');
        const same = [lane.enter('a', 'good'), lane.enter('b', 'good')];
        const other = lane.enter('a', 'other');

        lane.promote('good');
        expect((await Promise.all(same)).every(Boolean)).toBe(true);
        expect(await settled(other)).toBe('pending');
        // They went through beside the lane: its one place is still the first's.
        expect(lane.running).toBe(1);

        first?.leave();
        expect(await other).toBeTruthy();
    });

    it('gives a place back once, however often it is asked', async () => {
        const lane = make({ perAddress: 1 });
        const first = await lane.enter('a', 'k');
        const second = lane.enter('a', 'k');
        first?.leave();
        first?.leave();
        const third = lane.enter('a', 'k');

        expect(await second).toBeTruthy();
        expect(await settled(third)).toBe('pending');
        expect(lane.running).toBe(1);
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
    const source = (
        header?: 'cf-connecting-ip' | 'fly-client-ip',
        trusted?: string[],
    ): ClientAddressSource => ({
        header,
        trustedProxies: trusted && proxyList(trusted),
    });

    it('is the socket peer when no header is configured, whatever the request claims', () => {
        const forged = headers({
            'x-forwarded-for': '9.9.9.9',
            'cf-connecting-ip': '9.9.9.9',
            'fly-client-ip': '9.9.9.9',
            'x-real-ip': '9.9.9.9',
            forwarded: 'for=9.9.9.9',
        });
        expect(clientAddress('203.0.113.7', forged, source())).toBe('203.0.113.7');
    });

    it('is the configured header when it holds one address', () => {
        expect(
            clientAddress(
                '10.0.0.1',
                headers({ 'fly-client-ip': '198.51.100.4' }),
                source('fly-client-ip'),
            ),
        ).toBe('198.51.100.4');
        expect(
            clientAddress(
                '10.0.0.1',
                headers({ 'cf-connecting-ip': ' 198.51.100.4 ' }),
                source('cf-connecting-ip'),
            ),
        ).toBe('198.51.100.4');
    });

    it.each([
        ['missing', {}],
        ['empty', { 'fly-client-ip': '' }],
        ['two addresses', { 'fly-client-ip': '198.51.100.4, 198.51.100.5' }],
        ['not an address', { 'fly-client-ip': 'localhost' }],
        ['an address and more', { 'fly-client-ip': '198.51.100.4\tx' }],
        ['an address in brackets', { 'fly-client-ip': '[2001:db8::1]' }],
    ])('falls back on the peer when the header is %s', (_case, values) => {
        expect(clientAddress('10.0.0.1', headers(values), source('fly-client-ip'))).toBe(
            '10.0.0.1',
        );
    });

    it('H3: counts an IPv6 address by its /64, from the header and from the socket alike', () => {
        const one = headers({ 'fly-client-ip': '2001:db8:1:2:aaaa::1' });
        const other = headers({ 'fly-client-ip': '2001:DB8:1:2:bbbb::2' });

        expect(clientAddress('10.0.0.1', one, source('fly-client-ip'))).toBe('2001:db8:1:2::/64');
        expect(clientAddress('10.0.0.1', other, source('fly-client-ip'))).toBe('2001:db8:1:2::/64');
        for (const peer of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:a:b:c:d']) {
            expect(clientAddress(peer, headers(), source())).toBe('2001:db8:1:2::/64');
        }
        expect(clientAddress('2001:db8:1:3::1', headers(), source())).toBe('2001:db8:1:3::/64');
        expect(clientAddress('fe80::1%lo0', headers(), source())).toBe('fe80:0:0:0::/64');
        expect(clientAddress('::1', headers(), source())).toBe('0:0:0:0::/64');
    });

    it('reads an IPv4 address shown as IPv6 as the IPv4 it is', () => {
        expect(clientAddress('::ffff:203.0.113.7', headers(), source())).toBe('203.0.113.7');
        expect(clientAddress('::ffff:cb00:7107', headers(), source())).toBe('203.0.113.7');
        expect(
            clientAddress(
                '10.0.0.1',
                headers({ 'fly-client-ip': '::ffff:198.51.100.1' }),
                source('fly-client-ip'),
            ),
        ).toBe('198.51.100.1');
    });

    it('puts every request without a usable peer in one bucket', () => {
        expect(clientAddress(undefined, headers(), source())).toBe('unknown');
        expect(clientAddress('not an address', headers(), source())).toBe('unknown');
    });

    describe('the edge header, cf-connecting-ip', () => {
        const edge = { 'cf-connecting-ip': '198.51.100.4' };

        it('through a tunnel (no trusted ranges): believed unless the platform proxy forwarded the request', () => {
            expect(clientAddress('10.0.0.1', headers(edge), source('cf-connecting-ip'))).toBe(
                '198.51.100.4',
            );
            // The platform proxy marked it: it did not come through the tunnel,
            // so the client wrote the edge header itself. The peer, and not what it says.
            const direct = headers({ ...edge, 'fly-client-ip': '203.0.113.50' });
            expect(clientAddress('10.0.0.1', direct, source('cf-connecting-ip'))).toBe('10.0.0.1');
        });

        it('behind the edge then the platform proxy: believed when the edge is who called', () => {
            const ranges = ['173.245.48.0/20', '2400:cb00::/32'];
            const viaEdge = headers({ ...edge, 'fly-client-ip': '173.245.50.9' });
            const viaEdge6 = headers({ ...edge, 'fly-client-ip': '2400:cb00:12::1' });

            expect(clientAddress('10.0.0.1', viaEdge, source('cf-connecting-ip', ranges))).toBe(
                '198.51.100.4',
            );
            expect(clientAddress('10.0.0.1', viaEdge6, source('cf-connecting-ip', ranges))).toBe(
                '198.51.100.4',
            );
        });

        it('behind the edge then the platform proxy: a caller that skipped the edge counts as itself', () => {
            const ranges = ['173.245.48.0/20'];
            const skipped = headers({ ...edge, 'fly-client-ip': '203.0.113.50' });

            // Not one bucket for everybody, and not the address it claims: its own.
            expect(clientAddress('10.0.0.1', skipped, source('cf-connecting-ip', ranges))).toBe(
                '203.0.113.50',
            );
            // No platform header at all: it came some other way. The peer.
            expect(
                clientAddress('10.0.0.1', headers(edge), source('cf-connecting-ip', ranges)),
            ).toBe('10.0.0.1');
        });
    });

    it('refuses a list of proxies that is not one', () => {
        expect(() => proxyList(['10.0.0.0/8', '2001:db8::/32'])).not.toThrow();
        for (const bad of [
            '10.0.0.0',
            '10.0.0.0/33',
            'example.com/8',
            '2001:db8::/129',
            '/8',
            '',
        ]) {
            expect(() => proxyList([bad])).toThrow();
        }
    });
});
