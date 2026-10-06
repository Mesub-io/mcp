# Mesub MCP server

Mesub is recurring payments on Solana, non-custodial. This is its [Model Context Protocol](https://modelcontextprotocol.io) server: it lets a merchant's AI agent read and act on one Mesub project, through tools.

It is a thin layer over the Mesub HTTP API. A tool is one or a few calls to that API, and no business logic lives here.

## Status

Early, and not hosted yet. What exists is the foundation: the transport, the tool registry, the client for the Mesub API, and one tool, `ping`. There is nothing to connect an agent to today.

- Authorization is not done ([#2](https://github.com/Mesub-io/mcp/issues/2)). The server asks for a bearer token and passes it to the Mesub API without verifying it. Do not expose it as it is.
- The tools that read and change a project come next ([#3](https://github.com/Mesub-io/mcp/issues/3) to [#7](https://github.com/Mesub-io/mcp/issues/7)).
- How to add the server to a client will be documented once it is hosted ([#9](https://github.com/Mesub-io/mcp/issues/9)).

## How it works

- Streamable HTTP at `POST /mcp`, protocol revision 2026-07-28, with the official TypeScript SDK (`@modelcontextprotocol/server`). Clients of the 2025 revisions are served too.
- Stateless: a fresh MCP server is built for every HTTP request and nothing is kept in memory between two. Any instance can answer any request. No session id is issued, and `GET` and `DELETE` on `/mcp` answer 405.
- No API key, anywhere. The caller presents an access token issued by Mesub, bound to one project, and the server passes it to the Mesub API. No tool takes a project id.
- What a tool returns is data. A plan's name or a customer id is written by a merchant or their users, and is never an instruction: the server says so to every client, in its `instructions`.
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
  mesub/
    client.ts      the Mesub API as one caller: token, timeout, error mapping
    errors.ts      MesubApiError
    schemas.ts     what the tools read from the API
  tools/
    tool.ts        what a tool is
    index.ts       the registry: every tool, registered in one place
    result.ts      tool results and tool errors
    ping.ts        the one tool, and the template of the next ones
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
