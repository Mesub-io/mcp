import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * The headers CLIENT_IP_HEADER may name, the same two the Mesub API takes.
 * Each is written by one kind of proxy, over whatever the client sent, and is
 * worth believing only when that proxy is the one way in. Never
 * X-Forwarded-For, Forwarded nor X-Real-IP: a client writes its own.
 *
 * - `fly-client-ip`: the platform proxy, in front of an app reached on its
 *   public address. It writes who called IT.
 * - `cf-connecting-ip`: an edge network, in front of the platform proxy or
 *   through a tunnel to an app with no public address.
 */
export const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'fly-client-ip'] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];

const PLATFORM_PROXY_HEADER = 'fly-client-ip';
const EDGE_HEADER = 'cf-connecting-ip';

export interface ClientAddressSource {
    /** Undefined: the socket peer, which cannot be forged and is shared behind a proxy. */
    header: ClientIpHeader | undefined;
    /**
     * The edge's own addresses, when it sits in front of the platform proxy:
     * the edge header is believed only on a request the platform proxy says
     * one of them sent.
     */
    trustedProxies: BlockList | undefined;
}

/** A list of CIDR ranges. Throws on one that is not a range. */
export function proxyList(ranges: readonly string[]): BlockList {
    const list = new BlockList();
    for (const range of ranges) {
        const [address = '', length = '', ...rest] = range.split('/');
        const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : undefined;
        const prefix = /^\d{1,3}$/.test(length) ? Number(length) : Number.NaN;
        if (family === undefined || rest.length > 0 || prefix > (family === 'ipv4' ? 32 : 128)) {
            throw new TypeError('not a CIDR range');
        }
        list.addSubnet(address, prefix, family);
    }
    return list;
}

/**
 * Who a request counts as: the configured header when it holds exactly one
 * address and can be believed, the socket peer otherwise. An IPv6 address
 * counts by its /64, which is what one home or one machine is handed.
 *
 * The edge header, by where the server is:
 * - through a tunnel (no trusted ranges): believed, unless the platform proxy
 *   marked the request. Such a request did not come through the tunnel, so
 *   the client wrote the edge header itself: the peer counts.
 * - behind the edge then the platform proxy (trusted ranges set): believed
 *   when the platform proxy says the edge sent the request. Otherwise the
 *   caller skipped the edge, and counts as the address the platform proxy saw.
 */
export function clientAddress(
    peer: string | undefined,
    headers: Headers,
    source: ClientAddressSource,
): string {
    const fallback = bucketOf(peer) ?? 'unknown';
    const { header, trustedProxies } = source;

    if (header === undefined) return fallback;
    if (header !== EDGE_HEADER) return bucketOf(headers.get(header)) ?? fallback;

    const platform = headers.get(PLATFORM_PROXY_HEADER);
    if (trustedProxies === undefined) {
        return platform === null ? (bucketOf(headers.get(EDGE_HEADER)) ?? fallback) : fallback;
    }

    const caller = addressOf(platform);
    if (caller === undefined) return fallback;
    return trustedProxies.check(caller.address, caller.family)
        ? (bucketOf(headers.get(EDGE_HEADER)) ?? fallback)
        : caller.bucket;
}

function bucketOf(value: string | null | undefined): string | undefined {
    return addressOf(value)?.bucket;
}

interface Address {
    /** As `BlockList` reads it. */
    address: string;
    family: 'ipv4' | 'ipv6';
    /** What a limit counts: an IPv4 as is, an IPv6 by its /64. */
    bucket: string;
}

/**
 * One address. Anything else, two addresses joined by a repeated header
 * included, is no address at all.
 */
function addressOf(value: string | null | undefined): Address | undefined {
    if (typeof value !== 'string') return undefined;

    const text = value.trim();
    if (isIPv4(text)) return { address: text, family: 'ipv4', bucket: text };
    if (!isIPv6(text)) return undefined;

    const groups = groupsOf(text);
    // ::ffff:0:0/96 is an IPv4 address: a dual stack socket shows IPv4 peers so.
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        const [high = 0, low = 0] = groups.slice(6);
        const mapped = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
        return { address: mapped, family: 'ipv4', bucket: mapped };
    }

    const hex = groups.map((group) => group.toString(16));
    return { address: hex.join(':'), family: 'ipv6', bucket: `${hex.slice(0, 4).join(':')}::/64` };
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
