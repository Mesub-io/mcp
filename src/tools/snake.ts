/** `collectedThisPeriodUsd` as `collected_this_period_usd`. A key that starts in upper case is a value (a status), left alone. */
type SnakeKey<S extends string> = S extends Uncapitalize<S> ? Lowered<S> : S;
type Lowered<S extends string> = S extends `${infer Head}${infer Tail}`
    ? Head extends Lowercase<Head>
        ? `${Head}${Lowered<Tail>}`
        : `_${Lowercase<Head>}${Lowered<Tail>}`
    : S;

export type Snake<T> = T extends readonly (infer Item)[]
    ? Snake<Item>[]
    : T extends object
      ? { [Key in keyof T as Key extends string ? SnakeKey<Key> : Key]: Snake<T[Key]> }
      : T;

const snakeKey = (key: string): string =>
    /^[a-z]/.test(key) ? key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`) : key;

/**
 * An answer of the agent routes, which are camelCase, with the snake_case
 * keys every tool returns. Keys only, at every depth: no value is touched.
 */
export function snake<T>(value: T): Snake<T> {
    if (Array.isArray(value)) return value.map((item) => snake(item)) as Snake<T>;
    if (typeof value !== 'object' || value === null) return value as Snake<T>;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [snakeKey(key), snake(item)]),
    ) as Snake<T>;
}
