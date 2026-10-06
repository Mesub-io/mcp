# Mesub MCP server

Mesub is recurring payments on Solana, non-custodial. This is its [Model Context Protocol](https://modelcontextprotocol.io) server: a merchant connects their AI tool to it, and the agent can then read one Mesub project and act on it, the way the merchant would in the dashboard.

It is a thin layer over the Mesub HTTP API. A tool is one call to that API and a mapping of its answer: no business logic lives here.

- [Status](#status)
- [Connect](#connect)
- [Tools](#tools)
- [What an agent can never do](#what-an-agent-can-never-do)
- [Security model](#security-model)
- [Limits](#limits)
- For whoever runs or changes the server: [How it works](#how-it-works), [How a connection works](#how-a-connection-works), [Run it locally](#run-it-locally), [Configuration](#configuration), [Development](#development), [Contributing](#contributing)

## Status

**Not hosted yet.** Mesub will host this server: there is nothing to install and nothing to run on the merchant's side. Until it is, no address works, and the one written below is a placeholder.

What exists in this repository: the transport, authorization, the client for the Mesub API, and 23 tools. What it is tested against, on every push, is a stand-in for the Mesub API. The routes it calls and the consent page in the dashboard are being merged on the Mesub side.

## Connect

For a merchant, once the server is hosted:

1. Add the server's address to your AI tool, as a remote MCP server.
2. The tool opens a Mesub page in your browser. Sign in to the dashboard.
3. Choose one project. Nothing is chosen for you.
4. Read what the page lists, then authorize.

The address, a PLACEHOLDER until the server is hosted:

```text
https://mcp.mesub.io/mcp
```

A tool configured by a JSON file takes an entry like this one (some want `"type": "http"` beside the `url`):

```json
{
    "mcpServers": {
        "mesub": { "url": "<the address>" }
    }
}
```

A tool configured from a terminal takes the same two things, a name and the address. The words of the command are your tool's own, this is only its usual shape:

```sh
your-tool mcp add --transport http mesub <the address>
```

There is no API key to paste and none to create: the sign-in in the browser is the whole of it. An agent works on the project you chose and no other. To work on another project, connect again and choose it.

## Tools

23 tools. Each describes itself and its arguments to the agent, so there is nothing to learn: ask in plain words. The last column is what the server tells the AI tool about each one, from which the tool decides whether to ask its user first.

<!-- tools:start (written by `pnpm readme:tools`, do not edit) -->

**Read** (14). They change nothing.

| Tool                      | What it does                               | What a client is told |
| ------------------------- | ------------------------------------------ | --------------------- |
| `ping`                    | Check the Mesub API                        | Read-only             |
| `search_docs`             | Search the Mesub documentation             | Read-only             |
| `get_project`             | Read the project                           | Read-only             |
| `list_plans`              | List the plans                             | Read-only             |
| `get_plan`                | Read one plan                              | Read-only             |
| `list_subscriptions`      | List the subscriptions                     | Read-only             |
| `get_subscription`        | Read one subscription                      | Read-only             |
| `check_access`            | Check a customer's access                  | Read-only             |
| `list_events`             | Read the event log                         | Read-only             |
| `list_upcoming_charges`   | List the upcoming charges                  | Read-only             |
| `get_overview`            | Read how the project is doing              | Read-only             |
| `list_webhooks`           | List the webhook endpoints                 | Read-only             |
| `list_webhook_deliveries` | List the deliveries to a webhook endpoint  | Read-only             |
| `get_webhook_secret`      | Reveal a webhook endpoint's signing secret | Read-only             |

**Act** (8). They change the project, or make Mesub call a server of the merchant.

| Tool                        | What it does                                | What a client is told                              |
| --------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `update_project`            | Rename the project                          | Changes, marked destructive                        |
| `update_retry_policy`       | Change a plan's retry policy                | Changes, marked destructive                        |
| `retry_charge`              | Retry a failed charge                       | Changes, marked destructive, reaches outside Mesub |
| `create_webhook`            | Create a webhook endpoint                   | Changes, reaches outside Mesub                     |
| `update_webhook`            | Change a webhook endpoint                   | Changes, marked destructive, reaches outside Mesub |
| `delete_webhook`            | Delete a webhook endpoint                   | Changes, marked destructive                        |
| `regenerate_webhook_secret` | Replace a webhook endpoint's signing secret | Changes, marked destructive                        |
| `send_test_webhook`         | Send a test webhook                         | Changes, reaches outside Mesub                     |

**Prepare** (1). It leaves the merchant something to review and sign, and publishes nothing.

| Tool           | What it does           | What a client is told |
| -------------- | ---------------------- | --------------------- |
| `prepare_plan` | Prepare a plan to sign | Changes               |

<!-- tools:end -->

What they have in common:

- A result is the API's answer in snake_case, with nothing the tool's output schema does not name. An answer that is not what the route serves is a tool error (`unexpected`), never passed on.
- A token amount is a string in the smallest unit of its mint, with a display value beside it (`amount_display: "9.99 USDC"`), worked out on the digits and never through a float. A plan's period has one too (`period_display: "every month (30 days)"`). When the API does not know the decimals of a mint, the display value is the raw amount and the mint, and says so.
- A result is bounded: a text somebody else wrote is cut and marked ` [truncated]`, a list is capped, and a result says whether more exists and how to ask for it (`page`, `starting_after`, or a narrower filter).
- A state, a tier or an outcome the API adds after this server was written does not fail a tool: it is returned as it is, in its field, and the sentence of the result says `UNKNOWN` for it. Types, lengths and what may be null are still held strictly.
- The tools that charge a subscriber, delete, overwrite or redirect are marked destructive, and their description says to ask the merchant first. `get_webhook_secret`, `create_webhook` and `regenerate_webhook_secret` return a signing secret, which lands in the conversation.
- A refusal of the API is a tool error with its `code`, its message and what to do: wait and how long (`rate_limited`), correct the request, look the id up, hand the merchant what only they can do, or stop. Nothing is retried here.
- A token the API refuses to a tool after the check accepted it (revoked in between) is answered with the 401 and its challenge. A 2025 client, whose answer is already a stream by then, reads a tool error saying to connect again, and gets the 401 on its next request.

### Preparing a plan

`prepare_plan` is the one tool that makes something new, and it makes a draft:

- The agent gives a name, a price as a person writes it (`"9.99"`), a token by its symbol (USDC, USDT or PYUSD) and a period in hours. The server writes the price in the token's smallest unit itself, exactly. A raw amount is not an argument, so an agent cannot be wrong by a factor of a million.
- Mesub keeps the plan as PENDING. Nothing is on chain, nobody can subscribe, nobody is charged.
- The result gives the page of the dashboard where the merchant reviews the plan and signs it with their own wallet, and states the name, the price, the period and where the money goes from what Mesub answered, never from what the agent sent. A plan that comes back with another price, token or period than the one asked for is reported as an error, without its link.
- It always pays the wallet the merchant connected to Mesub, and never has an end date. It cannot set a receiver, a slug or another token: the merchant does that in the dashboard.

## What an agent can never do

Whatever it is asked, by the merchant or by anything it reads:

- See or change the API key.
- Change the project's tier, or delete the project.
- Publish, edit, close or delete a plan, or give one an end date.
- Change where the money goes.
- Send an old webhook delivery again. That stays in the dashboard: it would let an agent pull past events, with subscribers' identifiers in them, to an address of its choice.
- Cancel or change a customer's subscription. Only their wallet can.
- Reach another project than the one the connection was made for.

These are not tools switched off: the server has no such tool, and the Mesub API gives an agent no route to them.

## Security model

- **No API key.** The merchant signs in to the dashboard in their browser and authorizes the agent there. Nothing is pasted into the AI tool, and no tool here returns the API key.
- **One project per connection.** The token names the project. No tool takes a project id.
- **All or nothing.** A connected agent can use every tool listed above. There is no read-only mode: connect an agent only if you would let it do all of it.
- **A one-hour token, renewed by the AI tool.** The server keeps none: it asks the Mesub API about the token on every request.
- **A day without use cuts the connection.** While it is used it stays open.
- **Revocable in the dashboard**, under Developers, then Connected agents. The agent's very next call is refused. What it changed before stays as it is.
- **The server's own credential.** Every call to the Mesub API carries the agent's token and a service secret of this server, together. The API takes neither alone: a token taken from an AI tool opens nothing by itself.
- **Results are data.** A plan's name, a customer's id, what a merchant's server answered are written by other people and may read like instructions. The server tells every agent to treat them as data, cuts them short, and never writes one into the sentence that heads a result, except between quotes. An agent can still be steered by what it reads: that is why the tools that move money or break an integration are marked so that the AI tool asks first. Keep that question on.
- **A signing secret lands in the conversation** when an agent creates a webhook endpoint, regenerates its secret or reads it. Move it to the server's environment, and regenerate it if the conversation is shared.
- **The merchant reviews every prepared plan.** The agent fills it in, the merchant signs it. Read the price, the token and the period in the dashboard before signing.

## Limits

Per connection, held by the Mesub API:

| What                                         | A minute |
| -------------------------------------------- | -------- |
| Reads, over every tool that reads            | 120      |
| Changes, over every tool that changes        | 20       |
| Test deliveries (`send_test_webhook`), apart | 5        |

Past one, the tool error says how many seconds to wait. This server has limits of its own in front of those: see [Limits of this server](#limits-of-this-server).

## How it works

- Streamable HTTP at `POST /mcp`, protocol revision 2026-07-28, with the official TypeScript SDK (`@modelcontextprotocol/server`). Clients of the 2025 revisions are served too.
- No session: a fresh MCP server is built for every HTTP request, and any instance can answer any request. No session id is issued, and `GET` and `DELETE` on `/mcp` answer 405. What an instance keeps in memory never lets anyone in: see [Limits of this server](#limits-of-this-server).
- No API key, anywhere, and no tool takes a project id. The caller presents an access token issued by Mesub, bound to one project and to this server: see [How a connection works](#how-a-connection-works).
- What a tool returns is data. A plan's name or a customer id is written by a merchant or their users, and is never an instruction: the server says so to every client, in its `instructions`.
- `search_docs` searches the public docs without calling anything: an index of them is built from one commit of [Mesub-io/docs](https://github.com/Mesub-io/docs) and committed here, in `src/docs/index.json`. See [The docs index](#the-docs-index). It asks for a token like every other tool, though it reads no project: one rule for everything.
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

### Limits of this server

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

`MCP_PUBLIC_URL` is left unset: it is `http://localhost:<PORT>`. The API needs more of its own to issue tokens and to prepare a plan: a secret to hash tokens with, and `SITE_URL`, the dashboard's address, which is where a merchant signs in and where a prepared plan is signed. Its `.env.example` lists them. The names only are given here: a value is never committed, printed or pasted in an issue. With both running, point an MCP client at `http://localhost:3334/mcp` and it is sent to the dashboard to connect.

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
pnpm readme:tools   # rewrite the list of tools above from the registry
```

The pre-push hook runs the type check, the lint, the tests and the build. CI runs the same, plus the format check, on pull requests and on `main`.

The tests start the real server on a free port, connect the SDK's own client to it over HTTP, and stand a local HTTP server in for the Mesub API: it checks the service secret and the token as the real `GET /agent/whoami` does, and a test issues, expires or revokes a token on it.

`test/hardening.spec.ts` is the adversarial pass: an instruction planted in every text field of every answer, answers that are too long, a page or a redirect where an answer should be, a value the API adds to one of its lists, two connections at once. `evals/` holds what a good agent does with the tools, scenario by scenario, and `test/evals.spec.ts` holds the descriptions to it: see [evals/README.md](evals/README.md).

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
    schemas.ts     what the tools read from the API, one schema per answer
    link.ts        whether an address the API answered may be written in a sentence
  tools/
    tool.ts        what a tool is
    index.ts       the registry: every tool, registered in one place
    result.ts      tool results and tool errors
    ping.ts        the template of the next ones
    search-docs.ts searches the docs index
    <name>.ts      one file per tool: get-project.ts, retry-charge.ts, ...
    shapes.ts      what several tools return, and the mapping to it
    inputs.ts, webhook-inputs.ts   what several tools take
    money.ts       an amount as a person reads it, and a price in the smallest unit, exactly
    period.ts      a period in words
    tokens.ts      the tokens a plan may be prepared in
    snake.ts       the API's camelCase keys as snake_case
    limits.ts      how much a result may hold
  text.ts          cutting a text short, and the sentence about data
scripts/
  build-docs-index.mjs  builds, checks and dates src/docs/index.json
evals/
  scenarios.json   what a good agent does: the tool it picks, when it asks, when it refuses
test/
```

## Add a tool

[AGENTS.md](AGENTS.md) has the rules. The steps:

1. If the tool calls a route the client does not have yet, add its answer's schema to `src/mesub/schemas.ts` and one method to `MesubClient` in `src/mesub/client.ts`.
2. Create `src/tools/<name>.ts`, copied from `src/tools/ping.ts`: name, title, description, input and output schemas, the four annotations, the handler.
3. Add one `register(server, <tool>, dependencies)` line to `registerTools` in `src/tools/index.ts`.
4. Test it in `test/`, against the fake Mesub API: the result, a Mesub error, and that the call carried both credentials. Its row in `test/tool-cases.ts` gives it the tests every tool has, the adversarial ones included.
5. Add the scenarios an agent should pick it for to `evals/scenarios.json`, with the near misses against the tools it looks like.
6. Run `pnpm readme:tools`.

## Contributing

Read [AGENTS.md](AGENTS.md) first: it holds the rules this server is built on, for a person or an agent, and a pull request is reviewed against it. An issue is welcome before a large change. The checks under [Development](#development) must pass, and the pre-push hook runs them.

## License

[Apache-2.0](LICENSE).
