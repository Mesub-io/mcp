import { isIPv4, isIPv6 } from 'node:net';

/**
 * The headers CLIENT_IP_HEADER may name, the same two the Mesub API takes:
 * each is written by one kind of proxy directly in front of the server, over
 * whatever the client sent. Never X-Forwarded-For, Forwarded nor X-Real-IP: a
 * client writes its own. Unset, every limit counts the socket peer, which is
 * shared behind a proxy but cannot be forged.
 */
export const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'fly-client-ip'] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];

/** Set on every request the platform proxy forwarded. */
const PLATFORM_PROXY_HEADER = 'fly-client-ip';
/** Set by an edge network in front of the platform, or by anybody who is not behind it. */
const EDGE_HEADER = 'cf-connecting-ip';

/**
 * Who a request counts against in a per-address limit: the configured header
 * when it holds exactly one address, the socket peer otherwise.
 *
 * A client's IPv6 address counts by its /64, which is what one home or one
 * machine is handed: counted whole, a single client would have 2^64 budgets.
 * The peer counts whole. The edge header is not believed on a request the
 * platform proxy forwarded: such a request did not come through the edge, so
 * the client wrote that header itself.
 */
export function clientAddress(
    peer: string | undefined,
    headers: Headers,
    header: ClientIpHeader | undefined,
): string {
    const fallback = addressOf(peer, 'whole') ?? 'unknown';

    if (header === undefined) return fallback;
    if (header === EDGE_HEADER && headers.has(PLATFORM_PROXY_HEADER)) return fallback;

    return addressOf(headers.get(header), '/64') ?? fallback;
}

/**
 * One address as a bucket: an IPv4 as is, an IPv6 written out in full, whole
 * or cut to its /64. Anything else, two addresses joined by a repeated header
 * included, is no address at all.
 */
function addressOf(value: string | null | undefined, width: 'whole' | '/64'): string | undefined {
    if (typeof value !== 'string') return undefined;

    const address = value.trim();
    if (isIPv4(address)) return address;
    if (!isIPv6(address)) return undefined;

    const groups = groupsOf(address);
    // ::ffff:0:0/96 is an IPv4 address: a dual stack socket shows IPv4 peers so.
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        const [high = 0, low = 0] = groups.slice(6);
        return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    }

    const hex = groups.map((group) => group.toString(16));
    return width === 'whole' ? hex.join(':') : `${hex.slice(0, 4).join(':')}::/64`;
}

/** The eight groups of an address isIPv6 accepted, its zone dropped. */
function groupsOf(address: string): number[] {
    const [head, tail] = (address.split('%')[0] ?? '').split('::');
    // A trailing dotted IPv4 (::ffff:1.2.3.4) fills two groups, not one.
    const groups = (part: string | undefined) =>
        (part ? part.split(':') : []).flatMap((group) => {
            if (!group.includes('.')) return [parseInt(group, 16)];
            const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
            return [(a << 8) | b, (c << 8) | d];
        });
    const left = groups(head);
    const right = tail === undefined ? [] : groups(tail);

    return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}
