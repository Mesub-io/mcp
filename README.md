# Mesub MCP server

Mesub is recurring payments on Solana, non-custodial. This is its [Model Context Protocol](https://modelcontextprotocol.io) server: it lets a merchant's AI agent read and act on one Mesub project, through tools.

It is a thin layer over the Mesub HTTP API. A tool is one or a few calls to that API, and no business logic lives here.

## Status

Early, and not hosted yet. What exists is the foundation: the transport, the tool registry, the client for the Mesub API, and two tools, `ping` and `search_docs`. There is nothing to connect an agent to today.

- Authorization is not done ([#2](https://github.com/Mesub-io/mcp/issues/2)). The server asks for a bearer token and passes it to the Mesub API without verifying it. Do not expose it as it is.
- The tools that read and change a project come next ([#3](https://github.com/Mesub-io/mcp/issues/3) to [#7](https://github.com/Mesub-io/mcp/issues/7)).
- `search_docs` asks for a token like every other tool, though it reads no project. Whether to open it is not decided.
- How to add the server to a client will be documented once it is hosted ([#9](https://github.com/Mesub-io/mcp/issues/9)).

## How it works

- Streamable HTTP at `POST /mcp`, protocol revision 2026-07-28, with the official TypeScript SDK (`@modelcontextprotocol/server`). Clients of the 2025 revisions are served too.
- Stateless: a fresh MCP server is built for every HTTP request and nothing is kept in memory between two. Any instance can answer any request. No session id is issued, and `GET` and `DELETE` on `/mcp` answer 405.
- No API key, anywhere. The caller presents an access token issued by Mesub, bound to one project, and the server passes it to the Mesub API. No tool takes a project id.
- What a tool returns is data. A plan's name or a customer id is written by a merchant or their users, and is never an instruction: the server says so to every client, in its `instructions`.
- `search_docs` searches the public docs without calling anything: an index of them is built from one commit of [Mesub-io/docs](https://github.com/Mesub-io/docs) and committed here, in `src/docs/index.json`. See [The docs index](#the-docs-index).
- `GET /health` answers 200 with the server's name and version.

## Run it locally

Node 22 or later, and pnpm.

```sh
pnpm install
pnpm build
MESUB_API_URL=http://localhost:3333 pnpm start
```

```sh
curl http://localhost:3000/health
# {"status":"ok","name":"mesub-mcp","version":"0.1.0"}
```

`pnpm dev` rebuilds and restarts on every change.

Or in a container:

```sh
docker build -t mesub-mcp .
docker run --rm -p 3000:3000 -e MESUB_API_URL=https://api.mesub.io mesub-mcp
```

### Configuration

Read once from the environment, and checked at start: a value that does not fit stops the process with a line naming the variable.

| Variable              | Default                   | What it is                                                                                                 |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `MESUB_API_URL`       | `https://api.mesub.io`    | The Mesub HTTP API the tools call.                                                                         |
| `PORT`                | `3000`                    | The port to listen on.                                                                                     |
| `HOST`                | `127.0.0.1`               | The interface to listen on. The container image sets `0.0.0.0`.                                            |
| `MCP_PUBLIC_URL`      | `http://localhost:<PORT>` | Where clients reach the server, without `/mcp`. Its hostname is the one browser origin allowed by default. |
| `MCP_ALLOWED_ORIGINS` | none                      | More hostnames a browser `Origin` may carry, separated by commas, without scheme nor port.                 |
| `LOG_LEVEL`           | `info`                    | `debug`, `info`, `warn`, `error` or `silent`.                                                              |

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

The tests start the real server on a free port, connect the SDK's own client to it over HTTP, and stand a local HTTP server in for the Mesub API.

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
  logger.ts        JSON lines, credentials redacted
  app.ts           the HTTP surface: /health, /mcp and its guards
  auth.ts          the auth seam, filled by #2
  server.ts        the MCP server: instructions, stateless handler
  version.ts       the server's name and version
  docs/
    index.json     the docs, indexed: written by scripts/build-docs-index.mjs
    docs-index.ts  the index as the server reads it
    search.ts      the search: tokens, scoring, passages
  mesub/
    client.ts      the Mesub API as one caller: token, timeout, error mapping
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
4. Test it in `test/`, against the fake Mesub API: the result, and a Mesub error.

## License

[Apache-2.0](LICENSE).
