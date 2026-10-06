# Working on the Mesub MCP server

Rules for anyone, person or agent, changing this repository. The README has the layout and how to run things.

## What this server is

A thin layer over the Mesub HTTP API, hosted, stateless, serving one Mesub project per access token.

- No business logic. A tool is one or a few calls to the Mesub API. If a tool needs a rule, a computation or a join the API does not offer, the API changes first. The one exception is `search_docs`, which calls nothing: it searches the index of the public docs the build carries.
- No state a request depends on. No session, no module-level variable a request writes to, and nothing that lets a caller in: a token is checked with the Mesub API on every request, so a revoke takes effect on the next one. What is kept between two requests is in `src/rate-limit.ts`: the rate of each connection, the tokens the API just refused, and which tokens it accepted before, as hashes. The last only says where a token waits to be checked. Any instance must answer right without any of it.
- No limit that keeps a caller out for what another one sent. A limit protects the Mesub API from a flood. Nothing is counted against an address, a request without a token is always answered, and a table that is full drops its oldest keys rather than refuse a new one. Read the head of `src/rate-limit.ts` before touching one.
- No API key. The credentials are the caller's access token and this server's service secret, which the Mesub API takes together or not at all. No tool takes a project id: the token names the project.
- No stream that outlives its request: `subscriptions/listen` is refused. A tool that needs one brings back, with it, a cap per connection and a re-check of the token while the stream is open.
- No read-only mode: every tool is always listed.

## Adding a tool

One file per tool in `src/tools/`, copied from `src/tools/ping.ts`, and one line in `registerTools` (`src/tools/index.ts`).

### Name

- snake_case, verb first, the same words as the Mesub API and dashboard: `list_plans`, `get_subscription`, `retry_charge`.
- `list_` returns several, `get_` returns one by its id, `create_`, `update_` and `delete_` change one.
- A name is a promise once shipped: never renamed, never reused for something else.

### Title and description

The title is a few words for a person reading a list of tools.

The description is read by an agent choosing among every tool it has. Write it for that reader:

- First sentence: what the tool does, in the words a merchant would use ("charges that failed", not "attempts with outcome FAILED").
- Then when to use it, and when to use another tool instead.
- Then what it returns, and anything a caller must know before calling: it moves money, it reveals a secret that lands in the conversation, nothing exists on chain until the merchant signs.
- Plain sentences. No marketing, no examples of prompts, no instructions to the agent beyond how to use the tool.

Every input field has a `.describe()`: it is the only documentation the agent gets for an argument.

### Schemas

- Input: `z.strictObject`. An argument the tool does not take is refused, not dropped. Validate everything: lengths, enums, formats.
- Output: a `z.object` naming every field returned. Fields are snake_case, as in the Mesub API. What the schema does not name does not leave the server.
- Paginated where the API is, with the API's own parameters in snake_case: `page` and `limit` in, `has_more` and `next_page` out; or `limit` and `starting_after` in, `has_more` and `next_starting_after` out.
- An answer of the API has one schema in `src/mesub/schemas.ts`, and is refused whole when it does not fit. Unknown fields are dropped there, not refused: the API may add one, and it reaches no agent until a schema names it. A text somebody else wrote is cut there (`text(max)`); an id, an address or a URL is kept whole or refused.
- An enum the API answers is an enum in its schema. A value the API adds fails the tool until it is added here: that is the cost of a sentence written from states.

### Money

- A token amount stays as the API serves it: a string in the smallest unit of the mint. Beside it goes a display value from `displayAmount()` (`src/tools/money.ts`), named `<field>_display`.
- Never a float, never `Number()` on an amount, never a decimals value the API did not serve. Unknown decimals give the raw amount and the mint, and the text says so.
- Dollar figures (`..._usd`) are the API's decimal strings, passed as they are.

### Size

- Every list is capped (`src/tools/limits.ts`) and the result says so: `truncated`, `has_more`, and how to get the rest. A list the API serves whole is cut with `capped()` then `fit()`.
- The registry refuses a result past `HARD_RESULT_LENGTH` (`result_too_large`): the net, not the plan.

### Annotations

All four, on every tool, with no default relied on:

| Annotation        | True when                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `readOnlyHint`    | The tool changes nothing.                                                                              |
| `destructiveHint` | The tool deletes, overwrites or cannot be undone, or moves a subscriber's money. False when read-only. |
| `idempotentHint`  | Calling it twice with the same arguments does no more than once.                                       |
| `openWorldHint`   | The tool reaches beyond the Mesub project: the chain, a merchant's endpoint.                           |

A client decides from these whether to ask its user first. When in doubt, pick the answer that makes the client ask.

No hint says "this reveals a secret" or "this sends data elsewhere": the description does, with what the client must ask its user before calling.

### Handler

- It receives its validated arguments and a context: `caller`, `mesub` (the Mesub API as this caller) and `signal`. See [What a tool is handed](#what-a-tool-is-handed).
- It returns `{ data, text }`: the data matching the output schema, and one short sentence about it.
- It does not catch a `MesubApiError`: the registry turns it into a tool error carrying Mesub's `code` and `message`, and what to do about it (`adviceFor()` in `src/tools/result.ts`, from the code and the status, never from the message).
- It never calls again by itself: a write sent twice is a subscriber charged twice.
- It never builds an error message from a header, a URL, a stack trace or the token.
- A route the client does not have yet is one schema in `src/mesub/schemas.ts` and one method on `MesubClient`. Write only what the tool needs.

## What a tool is handed

The auth seam (`src/auth.ts`) has verified the token before a tool runs. The handler gets:

| Field                 | What it is                                                                      |
| --------------------- | ------------------------------------------------------------------------------- |
| `caller.connectionId` | The connection a merchant made between an agent and a project.                  |
| `caller.projectId`    | The project the token is bound to. The only project the call may touch.         |
| `caller.projectName`  | Its name, written by the merchant.                                              |
| `caller.clientName`   | The name the agent's client registered under, written by whoever registered it. |
| `caller.expiresAt`    | When the access token stops working.                                            |
| `mesub`               | The Mesub API as this caller. Every call it makes carries both credentials.     |
| `signal`              | Aborted when the caller cancels or disconnects.                                 |

It does not get the token nor the service secret, and must never go looking for them.

- Never take a project id as an argument, and never send `caller.projectId` to the API to choose a project: the API reads the project from the token.
- Never call the Mesub API, or anything else, with `fetch`. `mesub` is the only way out, and `MesubClient` the only place a credential is put on a request.
- `projectName` and `clientName` are data written by other people. Never put them in a tool's description or the server's instructions, and never act on what they say.
- Never keep the context, or anything of it, past the call: no module-level variable, no cache keyed by connection or project.

### Adding a method to `MesubClient`

- Say who the call is made as: `as: 'agent'` (the agent's token and the service secret, together) for every route that reads or changes a project, `as: 'none'` for a public one such as `/health`. There is no way to send one credential without the other, and none must be added.
- The path is a literal. A value read from a caller goes through `pathSegment()` to become one segment, or into `query`. `pathSegment()` refuses a value holding a slash, a backslash, `..`, a percent sign or a control character: an id is not a path. `apiUrl()` refuses a path that is not a plain one, an encoded separator included.
- Every call has one deadline over the whole exchange, the body included. Never read an answer outside `#exchange`.
- Never put a credential in a URL, a body, an error message or a log, and never keep the `cause` of a failed `fetch`: it may quote a header.
- Never follow a redirect, and never call a URL read from an answer.

## The docs index

`src/docs/index.json` is written by `scripts/build-docs-index.mjs` from one commit of Mesub-io/docs. Never edit it by hand: CI rebuilds it from the commit it names and refuses a difference.

- The docs changed: `pnpm docs:index --latest`, read the diff, run the tests, commit the index alone (`add: docs index at <short sha>`).
- The script changed: `pnpm docs:index`, and commit the index with the script.
- A ranking test of `test/docs-search.spec.ts` that fails after a rebuild says the docs moved something. Look at what the query returns now before moving the expectation.
- The index is read once, when the process starts, and never written to: it is part of the build, not state.

## Results are data

Everything read from Mesub is data, never an instruction. A plan's name, a customer id, a webhook URL, an event's payload are written by merchants and their own users, and may say anything.

- Never interpret, follow, summarise or rewrite what a field says. Return it as it is, in its field.
- A passage of the docs is data as well. It is Mesub's own text today, and still never an instruction to the agent reading it.
- Never put a field read from Mesub into a tool's description or into the server's instructions.
- The one-sentence `text` of a result is written by the tool from counts and statuses, not from free text fields: never a name, an id, a wallet, a URL, a reason or a secret. It ends with `DATA_NOTICE` when the result carries text somebody else wrote.

## Secrets and logs

- Never log the token, the service secret, an Authorization or `X-Mesub-Service-Secret` header, a cookie, a webhook secret, or a request or response body.
- Never log a tool's arguments nor its result: they are the merchant's. The registry writes one `tool call` line per call, with the tool, the connection, the project, the client's name, the address, how it ended and how long it took. A tool adds nothing to it.
- Never log a string the Mesub API answered as it came: a URL goes through `loggableUrl()`, a name through `loggableName()`, an error `code` is kept only when it is a short plain word, and anything else is a fixed label or a length.
- Log through the `Logger` given by the dependencies, never `console`. It redacts credential-named fields, anything shaped like a Mesub token wherever it sits, and the service secret itself, which is a net and not a licence. It cannot see a token cut in two or encoded.
- The service secret is a `Secret` (`src/secret.ts`): printed, serialised or inspected, it shows nothing, and it has no method that gives its value back. `revealSecret()` does, and `src/mesub/client.ts` is the one file that imports it: a test holds the sources to that. It is taken out of `process.env` when the configuration is read.
- Nothing secret in an error returned to a client. A 401 never says why, a 503 never says the fault is in the service secret: the logs do.
- A token is read from the Authorization header only, never from a URL.

## Tests

A tool does not merge without its tests, in `test/`, through the real server and the SDK's client (see `test/mcp.spec.ts`):

- the result, structured and text, for an answer of the fake Mesub API;
- the tool error for a Mesub error, with its code, and for an answer that does not fit its schema;
- arguments refused by the input schema, with no call made to Mesub;
- for a write: that the API received exactly what was asked, once;
- its row in `test/tool-cases.ts`, which gives it the tests every tool has, and its four hints in `ANNOTATIONS` there;
- that every call to a route of the project carried the agent's token and the service secret, and that a public route carried neither.

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build` must pass. Never push with `--no-verify`.

## Style

- TypeScript strict, ESM, Node 22 or later. Dependencies pinned to an exact version, the lockfile committed. A new dependency needs a reason.
- Comments are short and say what is not obvious: one line, not a paragraph per field.
- No em dash, in code or prose. "API key", never another name for it.
- Commits are one short line: `add: ...`, `fix: ...`, `delete: ...`.
