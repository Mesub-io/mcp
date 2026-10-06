const REDACTED = '[redacted]';

/** Where the values are: no property of a `Secret`, whatever looks at it. */
const values = new WeakMap<Secret, string>();

/**
 * A credential, held so that printing, logging, serialising or inspecting it
 * by accident shows nothing. It has no way to give its value back: only
 * `revealSecret` does, and only the Mesub API client imports it.
 */
export class Secret {
    constructor(value: string) {
        values.set(this, value);
    }

    /** A text with every occurrence of the value taken out. */
    scrub(text: string): string {
        const value = values.get(this);
        return value === undefined || value === '' ? text : text.replaceAll(value, REDACTED);
    }

    toString(): string {
        return REDACTED;
    }

    toJSON(): string {
        return REDACTED;
    }

    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return REDACTED;
    }
}

/**
 * The value itself, for the header it travels in. Imported by
 * `src/mesub/client.ts` and by nothing else: a test holds the sources to it.
 */
export function revealSecret(secret: Secret): string {
    return values.get(secret) ?? '';
}
