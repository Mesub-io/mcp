# Mesub MCP server

Mesub is recurring payments on Solana, non-custodial. This is its [Model Context Protocol](https://modelcontextprotocol.io) server: it lets a merchant's AI agent read and act on one Mesub project, through tools.

It is a thin layer over the Mesub HTTP API. A tool is one or a few calls to that API, and no business logic lives here.

## Status

Early, and not hosted yet. What exists is the foundation: the transport, authorization, the tool registry, the client for the Mesub API, and two tools, `ping` and `search_docs`.

- Authorization is done here ([#2](https://github.com/Mesub-io/mcp/issues/2)): the server takes the access tokens Mesub issues and nothing else. It needs a Mesub API whose authorization server for agents is switched on (`MCP_RESOURCE_URL` and what goes with it, on its side).
- The tools that read and change a project come next ([#3](https://github.com/Mesub-io/mcp/issues/3) to [#7](https://github.com/Mesub-io/mcp/issues/7)).
- `search_docs` asks for a token like every other tool, though it reads no project: one rule for everything.
- How to add the server to a client will be documented once it is hosted ([#9](https://github.com/Mesub-io/mcp/issues/9)).

## How it works

- Streamable HTTP at `POST /mcp`, protocol revision 2026-07-28, with the official TypeScript SDK (`@modelcontextprotocol/server`). Clients of the 2025 revisions are served too.
- No session: a fresh MCP server is built for every HTTP request, and any instance can answer any request. No session id is issued, and `GET` and `DELETE` on `/mcp` answer 405. What an instance keeps in memory is counters and refusals, never a verdict that lets anyone in: see [Rate limits](#rate-limits).
- No API key, anywhere, and no tool takes a project id. The caller presents an access token issued by Mesub, bound to one project and to this server: see [How a connection works](#how-a-connection-works).
- What a tool returns is data. A plan's name or a customer id is written by a merchant or their users, and is never an instruction: the server says so to every client, in its `instructions`.
- `search_docs` searches the public docs without calling anything: an index of them is built from one commit of [Mesub-io/docs](https://github.com/Mesub-io/docs) and committed here, in `src/docs/index.json`. See [The docs index](#the-docs-index).
- `GET /health` answers 200 with the server's name and version.

## How a connection works

The server is an OAuth 2.1 protected resource, as the MCP authorization specification (revision 2026-07-28) describes. The Mesub API is its authorization server. Nothing here issues, refreshes or stores a token.

1. A client calls `/mcp` without a token. Every request to `/mcp` needs one, the handshake included: the answer is 401 with

    ```
    WWW-Authenticate: Bearer error="invalid_token", error_description="...", resource_metadata="<MCP_PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"
    ```

2. The client reads the protected resource metadata (RFC 9728) there. It is also served at `/.well-known/oauth-protected-resource`, for a client that does not read the header. Both are public:

    ```json
    { "resource": "<MCP_PUBLIC_URL>/mcp", "authorization_servers": ["<MESUB_ISSUER_URL>"] }
    ```

3. The client goes to the Mesub API (`<MESUB_ISSUER_URL>/.well-known/oauth-authorization-server`), where a merchant signs in and connects the agent to one project. It comes back with an access token: opaque, good for one hour, for that project and for this server only.
4. On every request, the server asks the Mesub API who the token stands for: `GET <MESUB_API_URL>/agent/whoami`, with the agent's token and this server's service secret, together. The API takes neither alone. The answer must name this server as the token's audience and `MESUB_ISSUER_URL` as its issuer, or the request is refused.
5. A tool then runs for that connection: it is handed the connection, the project and the client, never the token.

No good answer is remembered: a connection revoked in the dashboard is refused on the very next request, on every instance. What the server answers when a token is not let in:

| Answer                              | When                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 with the challenge              | No token, something that is not a Mesub access token, or one the API refuses: unknown, expired, revoked, or issued for another server. Always the same. |
| 503 with `Retry-After`              | The token could not be checked: the API is down, slow, or answers something else than a verdict. Never a 401: the client has nothing to do again.       |
| 503 with `Retry-After`, logged loud | The API refuses this server's own service secret, or is not the issuer this server names. A configuration fault, on our side.                           |
| 429 with `Retry-After`              | A rate limit, here or at the API.                                                                                                                       |

Which of them it was is in the logs (`request refused`, `cannot check access tokens`, `rate limited`, each with a `reason` or a `limit`), never in the response.

### Rate limits

In the memory of each instance: two instances count apart, and a restart forgets. They keep a flood away from the Mesub API, which has its own limits behind.

| Limit                                          | A minute | Past it                                                 |
| ---------------------------------------------- | -------- | ------------------------------------------------------- |
| Requests of one address without a usable token | 60       | 429. They never reach the API.                          |
| Tokens of one address checked and not let in   | 30       | 429 for every request of that address carrying a token. |
| Requests of one connection                     | 120      | 429 for that connection.                                |

A token let in gives its place back, so an address is not held back by its valid traffic. A token not let in does not: refused, unanswered by the API, or over its connection's limit. So however many tokens an address makes up, the API is asked about 30 a minute. A token the API just refused is also refused for 30 seconds without asking again (10 000 remembered at most, by their hash); a refused token never becomes good, so this can only save a call. Callers behind one address share its budgets: one of them sending bad tokens can keep the others out for a minute.

The address is the socket peer. Behind a proxy that is the proxy, for everybody: set `CLIENT_IP_HEADER` to the header that proxy writes the client's address in, over whatever the client sent. `X-Forwarded-For` is never read: a client writes its own. Set the variable only when that proxy is the one way in: reached directly, a client would write the header itself and get a budget per value.

## Run it locally

Node 22 or later, and pnpm. The server does not start without `MESUB_SERVICE_SECRET` and `MESUB_ISSUER_URL`.

```sh
pnpm install
pnpm build
cp .env.example .env    # then fill it in
node --env-file=.env dist/main.js
```

```sh
curl http://localhost:3334/health
# {"status":"ok","name":"mesub-mcp","version":"0.1.0"}
curl -i -X POST http://localhost:3334/mcp
# 401, with the challenge
curl http://localhost:3334/.well-known/oauth-protected-resource/mcp
# {"resource":"http://localhost:3334/mcp","authorization_servers":["http://localhost:3333"]}
```

`pnpm dev` rebuilds and restarts on every change, with the variables of the shell it runs in.

### Against a local Mesub API

The API on `http://localhost:3333`, this server on `http://localhost:3334`, the dashboard on `http://localhost:3000`. The two sides must agree on three values:

| This server (`.env`)                           | The Mesub API (its own `.env`)               | Why                                                          |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `PORT=3334`                                    | `MCP_RESOURCE_URL=http://localhost:3334/mcp` | The audience of every token: this server's URL, with `/mcp`. |
| `MESUB_API_URL=http://localhost:3333`          | `PORT=3333`                                  | Where the tools and the token checks go.                     |
| `MESUB_ISSUER_URL=http://localhost:3333`       | `PUBLIC_API_URL=http://localhost:3333`       | The issuer, character for character.                         |
| `MESUB_SERVICE_SECRET=<32 characters or more>` | `MCP_SERVICE_SECRET=<the same value>`        | `openssl rand -base64 48`, once, for both.                   |

`MCP_PUBLIC_URL` is left unset: it is `http://localhost:<PORT>`. The API needs more of its own to issue tokens (a secret to hash them with, the dashboard's origin): its `.env.example` lists them. With both running, point an MCP client at `http://localhost:3334/mcp` and it is sent to the dashboard to connect.

Or in a container:

```sh
docker build -t mesub-mcp .
docker run --rm -p 3000:3000 --env-file .env -e PORT=3000 mesub-mcp
```

Inside a container `localhost` is the container itself: `MESUB_API_URL` must be where the API is reached from there.

### Configuration

Read once from the environment, and checked at start: a value that does not fit stops the process with a line naming the variable.

| Variable               | Default                   | What it is                                                                                                                                                               |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MESUB_SERVICE_SECRET` | none, required            | What this server proves itself to the Mesub API with, beside the agent's token. 32 characters at least, visible ASCII. The API holds the same. Never logged.             |
| `MESUB_ISSUER_URL`     | none, required            | The Mesub API's public URL, an origin without a path: the authorization server named in the metadata, and the issuer every token check must name. https, unless local.   |
| `MESUB_API_URL`        | `https://api.mesub.io`    | The Mesub HTTP API the tools and the token checks call. May be a private address, which is why the issuer is not derived from it.                                        |
| `PORT`                 | `3000`                    | The port to listen on.                                                                                                                                                   |
| `HOST`                 | `127.0.0.1`               | The interface to listen on. The container image sets `0.0.0.0`.                                                                                                          |
| `MCP_PUBLIC_URL`       | `http://localhost:<PORT>` | Where clients reach the server, without `/mcp`. `<MCP_PUBLIC_URL>/mcp` is the resource a token is issued for. Its hostname is the one browser origin allowed by default. |
| `MCP_ALLOWED_ORIGINS`  | none                      | More hostnames a browser `Origin` may carry, separated by commas, without scheme nor port.                                                                               |
| `CLIENT_IP_HEADER`     | none                      | `cf-connecting-ip` or `fly-client-ip`: the header the proxy in front writes the client's address in. Unset, the rate limits count the socket peer.                       |
| `LOG_LEVEL`            | `info`                    | `debug`, `info`, `warn`, `error` or `silent`.                                                                                                                            |

The service secret is a credential of this server, not of a merchant: it opens nothing at the API without an agent's token, and an agent's token opens nothing there without it. Rotate it by changing it on both sides; no connection is revoked. If the two sides disagree, every request is answered 503 and the logs say `service_credentials_refused`.

A request carrying an `Origin` that is not allowed is refused with 403, as the MCP specification requires against DNS rebinding. A request without one, which is every client that is not a browser, passes. When the public URL is a loopback one, the `Host` header is checked as well.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The pre-push hook runs the type check, the lint, the tests and the build. CI runs the same, plus the format check, on pull requests and on `main`.

The tests start the real server on a free port, connect the SDK's own client to it over HTTP, and stand a local HTTP server in for the Mesub API: it checks the service secret and the token as the real `GET /agent/whoami` does, and a test issues, expires or revokes a token on it.

## The docs index

`search_docs` reads `src/docs/index.json`: every page the docs' navigation lists, cut into sections of plain text, with the commit of the docs it was built from. The file is committed, so a clone builds, tests and runs with no network and no checkout of the docs, and a change of the docs reaches the server as a diff someone reads. The search itself is lexical (BM25 over the sections, headings and titles counting more, identifiers such as `plan_ended` matched whole, a typo forgiven), in `src/docs/search.ts`: no service, no API key.

```sh
pnpm docs:index            # rebuild: from ../docs-site or $MESUB_DOCS_DIR when there, else from the pinned commit
pnpm docs:index --latest   # rebuild from the tip of the docs' main, fetched from GitHub
pnpm docs:index --commit <sha>
pnpm docs:check            # is the committed index what its own docs commit builds?
pnpm docs:stale            # would the docs' main build other sections?
```

The pin is the commit the committed index names. To follow the docs: `pnpm docs:index --latest`, read the diff, run the tests, commit. A local checkout must have nothing uncommitted under `src/`, and its commit must be pushed, or CI cannot rebuild from it.

Two things keep the index honest. CI runs `docs:check` on every pull request: a hand-edited index, or a script changed without rebuilding, fails. A scheduled workflow runs `docs:stale` every day and fails when the docs' `main` has pages or sections the index does not. Every answer of `search_docs` also carries the docs commit and its date.

A hit's URL is `https://docs.mesub.io`, the page's path and the section's anchor, slugged as the docs site slugs headings. What the reference draws from the OpenAPI document (parameters, body, responses) is indexed too, without an anchor: the site shows it in tabs.

## Layout

```
src/
  main.ts          the process: configuration, start, signals
  start.ts         binds the app, graceful shutdown
  config.ts        the environment, validated
  secret.ts        a credential that cannot be printed
  logger.ts        JSON lines, credentials redacted
  app.ts           the HTTP surface: /health, the metadata, /mcp and its guards
  auth.ts          the auth seam: the 401, the metadata, the check of a token
  client-address.ts  who a request counts against in a per-address limit
  rate-limit.ts    the limits and the refused tokens, in memory
  server.ts        the MCP server: instructions, stateless handler
  version.ts       the server's name and version
  docs/
    index.json     the docs, indexed: written by scripts/build-docs-index.mjs
    docs-index.ts  the index as the server reads it
    search.ts      the search: tokens, scoring, passages
  mesub/
    client.ts      the Mesub API as one caller: both credentials or none, timeout, error mapping
    errors.ts      MesubApiError
    schemas.ts     what the tools read from the API
  tools/
    tool.ts        what a tool is
    index.ts       the registry: every tool, registered in one place
    result.ts      tool results and tool errors
    ping.ts        the template of the next ones
    search-docs.ts searches the docs index
scripts/
  build-docs-index.mjs  builds, checks and dates src/docs/index.json
test/
```

## Add a tool

[AGENTS.md](AGENTS.md) has the rules. The steps:

1. If the tool calls a route the client does not have yet, add its answer's schema to `src/mesub/schemas.ts` and one method to `MesubClient` in `src/mesub/client.ts`.
2. Create `src/tools/<name>.ts`, copied from `src/tools/ping.ts`: name, title, description, input and output schemas, the four annotations, the handler.
3. Add one `register(server, <tool>, dependencies)` line to `registerTools` in `src/tools/index.ts`.
4. Test it in `test/`, against the fake Mesub API: the result, a Mesub error, and that the call carried both credentials.

## License

[Apache-2.0](LICENSE).
