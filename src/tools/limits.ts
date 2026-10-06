// How much one result may hold. A result is read by a model: every list is
// capped and every text bounded, so no answer of the API can flood it.

/** The most items of a list the API serves whole, without pages. */
export const MAX_LIST_ITEMS = 100;
/** The most charge attempts returned with one subscription, newest first. */
export const MAX_ATTEMPTS = 50;
/** The most lines of a list nested in an answer. */
export const MAX_NESTED_ITEMS = 20;
/** The longest result of a list, as the JSON of its data: items past it are left out, the last first. */
export const MAX_RESULT_LENGTH = 60_000;
/** The longest result of any tool. Past it the call fails rather than flood the reader. */
export const HARD_RESULT_LENGTH = 150_000;

/** The first `max` items, and whether some were left out. */
export function capped<T>(items: readonly T[], max: number): { kept: T[]; truncated: boolean } {
    return { kept: items.slice(0, max), truncated: items.length > max };
}

/**
 * Drops items from the end of `list`, in place, until the JSON of `data`
 * fits. Says whether any was dropped. `data` must hold `list`.
 */
export function fit(data: unknown, list: unknown[], max = MAX_RESULT_LENGTH): boolean {
    let dropped = false;
    while (list.length > 1 && JSON.stringify(data).length > max) {
        list.pop();
        dropped = true;
    }
    return dropped;
}
