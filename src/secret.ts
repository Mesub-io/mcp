const REDACTED = '[redacted]';

/**
 * A credential, held so that printing, logging, serialising or inspecting it
 * by accident shows nothing. Its value leaves through `reveal` alone, which
 * only the Mesub API client calls, for the header it travels in.
 */
export class Secret {
    readonly #value: string;

    constructor(value: string) {
        this.#value = value;
    }

    reveal(): string {
        return this.#value;
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
