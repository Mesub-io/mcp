/** The longest address of the dashboard a result or an error may carry. */
export const MAX_LINK_LENGTH = 512;

// A space, a control character, a quote, a bracket or a backslash: nothing an address of ours holds.
// eslint-disable-next-line no-control-regex
const NOT_IN_A_LINK = /[\s\u0000-\u001f\u007f"'<>\\`]/;
const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a value the Mesub API answered is an address of the dashboard this
 * server may write in a sentence: https, or plain http on this machine, with
 * no credentials and nothing but an address in it. Never fetched from here.
 */
export function isLink(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > MAX_LINK_LENGTH) return false;
    if (NOT_IN_A_LINK.test(value) || !URL.canParse(value)) return false;

    const { protocol, hostname, username, password } = new URL(value);
    if (username !== '' || password !== '') return false;
    return protocol === 'https:' || (protocol === 'http:' && THIS_MACHINE.has(hostname));
}
