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
- No session: a fresh MCP server is built for every HTTP request, and any instance can answer any request. No session id is issued, and `GET` and `DELETE` on `/mcp` answer 405. What an instance keeps in memory never lets anyone in: see [Limits](#limits).
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

No good answer is taken for the next request: a connection revoked in the dashboard is refused on the very next one, on every instance. What the server answers when a token is not let in:

| Answer                              | When                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 401 with the challenge              | No token, something that is not a Mesub access token, or one the API refuses: unknown, expired or revoked. Always the same, and always answered, however many came before.                       |
| 503 with `Retry-After`              | The token could not be checked: the API is down, slow, short of room (its own 429), or answers something else than a verdict. Never a 401 nor a 429: the client has nothing to do but come back. |
| 503 with `Retry-After`, logged loud | A fault in how the two sides are set up: the API refuses this server's service secret, is not the issuer this server names, or issues tokens for another resource than this server.              |
| 503 with `Retry-After: 1`           | A token this instance has never seen accepted waited too long for its turn to be checked. See below.                                                                                             |
| 429 with `Retry-After`              | This connection is past its own rate. Nothing else answers 429.                                                                                                                                  |

Which of them it was is in the logs (`request refused`, `cannot check access tokens`, `checks shed`, `rate limited`, each with a `reason`), never in the response. A request let in leaves a line too (`request let in`: the connection, the project, the address), and so does every tool call (`tool call`: the tool, how it ended, how long it took, never an argument nor a result).

No `subscriptions/listen` stream is opened: the request is refused at once, and the server does not say its lists can change. Such a stream would outlive the check of its token, and so a revoke. It comes back with the first tool that has something to publish.

### Limits

In the memory of each instance: two instances count apart, and a restart forgets. The rule they are held to: a limit keeps a flood away from the Mesub API, and is never a way for one caller to keep another out. So no count is kept against an address.

| What                                                             | The limit                                       | Past it                                                                              | Who is affected                                  |
| ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Requests of one connection                                       | 120 a minute                                    | 429 with `Retry-After`. A token already seen is refused without asking the API.      | That connection.                                 |
| Checks in flight for tokens never seen accepted, for one address | 8 at a time, 64 more waiting up to 3 seconds    | The request waits its turn. No room or too long a wait: 503 with `Retry-After: 1`.   | Tokens never seen accepted, from that address.   |
| The same, for the whole instance                                 | 32 at a time, 1 024 waiting, addresses in turns | The same. With no room left, the address that takes the most of it gives a place up. | Tokens never seen accepted, while a flood lasts. |
| A token the API just refused                                     | Remembered 5 seconds, 10 000 at most            | 401 with the challenge, without asking the API again.                                | Whoever sends that token.                        |
| Log lines about one address being refused                        | 60 a minute                                     | The lines stop, and one says so. The requests are answered as before.                | Nobody.                                          |

What this comes to:

- A request without a token is always answered 401 with the challenge. It costs nothing, and a client that has no token yet needs it.
- A token the API accepted on this instance is checked again on every request, straight away. It never waits behind strangers, whatever they send, from its own address or any other. What is remembered of it (a hash, and its connection, until it expires) only says where it stands in line and what its connection's rate is. It lets nobody in.
- A token this instance has never seen accepted, valid or made up, is checked in turn. This is all a flood of made-up tokens costs the API: 8 checks at a time from one address, 32 from all of them together, never more. In checks a minute, that is the number in flight times sixty, divided by the seconds one check takes. The first request of a valid token on an instance may wait a moment, or be told to come back in a second, while such a flood lasts, and only then.
- One dead token sent again and again costs the API 12 checks a minute. Five seconds is longer than the retries a client makes on a dead token, and short enough that a token refused by mistake is good again almost at once.
- An outage of the API, or its own rate limit, is held against nobody: the moment it answers again, so does this server.
- A table that is full (50 000 addresses, connections or tokens) drops what it used least recently, and a log line says `limiter full`. Whoever fills one resets counters. They keep nobody out.

### The client address

It says whose turn it is among the tokens never seen, and which address a log line names. Nothing is refused by address, so a wrong setting here is never an outage: it makes the turns unfair.

Every header below is believed only because one proxy writes it over whatever the client sent. **If the server can be reached any other way than through that proxy, a client writes the header itself** and counts as whatever address it likes. Close every other way in before setting one.

| Where the server is                                                  | Set                                                                               | Why                                                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On this machine                                                      | Nothing.                                                                          | The socket peer is the caller.                                                                                                                                                               |
| Behind the platform proxy alone, on a public address                 | `CLIENT_IP_HEADER=fly-client-ip`                                                  | The platform proxy writes who called it.                                                                                                                                                     |
| Behind a tunnel from an edge network, with no public address         | `CLIENT_IP_HEADER=cf-connecting-ip`                                               | The edge writes the client. A request that carries `fly-client-ip` did not come through the tunnel: it counts as the socket peer, and its edge header is not believed.                       |
| Behind an edge network, then the platform proxy, on a public address | `CLIENT_IP_HEADER=cf-connecting-ip` and `TRUSTED_PROXY_CIDRS=<the edge's ranges>` | The edge header is believed when the platform proxy says the edge sent the request. A caller that skipped the edge counts as the address the platform proxy saw. Keep the ranges up to date. |
| Behind something else, or nothing                                    | `CLIENT_IP_HEADER=none`                                                           | The socket peer. Behind a proxy that is the proxy, for everybody: all callers take turns as one address. Nobody is refused for it, and a line at start says so.                              |

`X-Forwarded-For`, `Forwarded` and `X-Real-IP` are never read: a client writes its own. An IPv6 address counts by its /64. Once `MCP_PUBLIC_URL` is not on this machine the variable must be set, `none` included: nothing is assumed about what stands in front.

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

Inside a container `localhost` is the container itself: `MESUB_API_URL` must be where the API is reached from there, and if that is plain http to another machine, `MESUB_API_PRIVATE_NETWORK=true` has to say the network is private.

### Configuration

Read once from the environment, and checked at start: a value that does not fit stops the process with a line naming the variable.

| Variable                    | Default                   | What it is                                                                                                                                                                              |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESUB_SERVICE_SECRET`      | none, required            | What this server proves itself to the Mesub API with, beside the agent's token. 32 characters at least, visible ASCII without a space, a quote nor a backslash. The API holds the same. |
| `MESUB_ISSUER_URL`          | none, required            | The Mesub API's public URL, an origin without a path: the authorization server named in the metadata, and the issuer every token check must name. https, unless on this machine.        |
| `MESUB_API_URL`             | `https://api.mesub.io`    | The Mesub HTTP API the tools and the token checks call. May be a private address, which is why the issuer is not derived from it. https, unless on this machine.                        |
| `MESUB_API_PRIVATE_NETWORK` | none                      | `true` to let `MESUB_API_URL` be plain http to another machine. The service secret and every token then travel in clear: only on a network nobody else is on.                           |
| `PORT`                      | `3000`                    | The port to listen on.                                                                                                                                                                  |
| `HOST`                      | `127.0.0.1`               | The interface to listen on. The container image sets `0.0.0.0`.                                                                                                                         |
| `MCP_PUBLIC_URL`            | `http://localhost:<PORT>` | Where clients reach the server: an origin, without `/mcp` nor any path. `<MCP_PUBLIC_URL>/mcp` is the resource a token is issued for. Its origin is the one a browser may call from.    |
| `MCP_ALLOWED_ORIGINS`       | none                      | More origins a browser may call from, separated by commas, each with its scheme and its port if any: `https://app.example.com`.                                                         |
| `CLIENT_IP_HEADER`          | none on this machine      | `fly-client-ip`, `cf-connecting-ip` or `none`. Required once the public URL is not on this machine. See [The client address](#the-client-address).                                      |
| `TRUSTED_PROXY_CIDRS`       | none                      | With `cf-connecting-ip` only: the ranges of the edge network in front of the platform proxy, separated by commas.                                                                       |
| `LOG_LEVEL`                 | `info`                    | `debug`, `info`, `warn`, `error` or `silent`.                                                                                                                                           |

At start the server writes a line named `resource` with the resource it takes tokens for. It must be the API's `MCP_RESOURCE_URL`, character for character: if it is not, every request is answered 503 and the logs say `audience_mismatch` with both values.

The service secret is a credential of this server, not of a merchant: it opens nothing at the API without an agent's token, and an agent's token opens nothing there without it. It is read once and taken out of the process's environment.

**Rotating it is a hard cut.** The API holds one value, with no overlap between the old and the new. From the moment the two sides differ, every request is answered 503 and the logs say `service_credentials_refused`; no connection is revoked, and agents pick up where they were once both sides agree again. To rotate: generate the new value, set it on the API and on every instance of this server, and restart both as close together as the hosting allows. Expect 503s for as long as that takes, and rotate at once if the value may have leaked: together with a stolen agent token it opens the API without this server.

A request carrying an `Origin` that is not allowed is refused with 403, as the MCP specification requires against DNS rebinding, and a log line says so. An origin is compared whole: its scheme, its host and its port. A request without one, which is every client that is not a browser, passes. When the public URL is on this machine, a page of this machine may call from any port, and the `Host` header is checked as well.

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
  client-address.ts  the address a request counts as
  rate-limit.ts    the limits, in memory, and what none of them may do
  server.ts        the MCP server: instructions, stateless handler
  version.ts       the server's name and version
  docs/
    index.json     the docs, indexed: written by scripts/build-docs-index.mjs
    docs-index.ts  the index as the server reads it
    search.ts      the search: tokens, scoring, passages
  mesub/
    client.ts      the Mesub API as one caller: both credentials or none, one deadline, error mapping
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
