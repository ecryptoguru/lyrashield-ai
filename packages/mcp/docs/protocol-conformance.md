# MCP protocol conformance

Baseline: `@modelcontextprotocol/server` 2.1.0 and `@lyrashield/mcp` 0.2.10. The v1 SDK remains a development dependency only for legacy-client compatibility tests.

## Supported and tested

| Guarantee                                                                                                                                                                                                                                       | Evidence                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Protocol `2026-07-28` discovers and calls tools through the official v2 client                                                                                                                                                                  | `src/http-transport.test.ts`                               |
| Legacy protocols `2025-11-25` and `2025-06-18` still negotiate through `initialize`                                                                                                                                                             | `src/http-transport.test.ts`, `src/create-server.test.ts`  |
| SDK also accepts legacy `2025-03-26`, `2024-11-05`, and `2024-10-07`; these have not been separately tested against LyraShield clients                                                                                                          | SDK supported-version list; local interop unverified       |
| Unsupported protocol headers fail with HTTP 400 and list supported versions                                                                                                                                                                     | `src/http-transport.test.ts`                               |
| A mismatched modern `MCP-Method` header and body fail before tool execution                                                                                                                                                                     | `src/http-transport.test.ts`                               |
| Server metadata and instructions are returned during initialization                                                                                                                                                                             | `src/create-server.test.ts`                                |
| All tools expose title, input/output schemas, annotations, and explicit task semantics                                                                                                                                                          | `src/create-server.test.ts`                                |
| Success and error results expose both text and structured content                                                                                                                                                                               | `src/create-server.test.ts`, `src/server-approval.test.ts` |
| Hosted workspace responses are `no-store` and vary by authorization/protocol                                                                                                                                                                    | `src/http-transport.test.ts`                               |
| Read tools never prompt; delegated writes require an idempotency key and matching connection grant; nondelegated API-key writes receive `connect_required` and exact-input approval is retained for legacy hosted nondelegated credentials only | `src/create-server.test.ts`, `src/remote-approval.test.ts` |

## Intentionally unsupported

LyraShield does not advertise or emulate these optional features:

- list-result `ttlMs` and `cacheScope` fields;
- MRTR retry/input-response exchange;
- MCP protocol Tasks.

The v2 SDK removed experimental MCP Tasks. Existing scans return durable LyraShield scan IDs and expose polling through `lyrashield_get_scan_status`. The 2026 revision provides multi-round-trip requests, but LyraShield tools do not request client input during a hosted call. Authenticated hosted mutations continue to use server-side connection grants, idempotency, and the existing approval path. The endpoint has no cache policy for principal-scoped tool lists, so all responses stay private and `no-store`.

The 2026 Tasks extension is not enabled. `@modelcontextprotocol/server` 2.1.0 rejects modern `tasks/get` and `tasks/cancel` before application handlers run. The official `@modelcontextprotocol/ext-tasks` package currently provides requester APIs and a 2025-11-25 receiver, but no 2026 receiver integration. See the [SDK migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md), [SDK extension roadmap](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md), and [Tasks package](https://github.com/modelcontextprotocol/ext-tasks). Until an official modern receiver supports those methods, LyraShield must not advertise `io.modelcontextprotocol/tasks` or return task handles. The durable `AgentOperation` ledger already supports idempotent submission recovery, but it is not a task-result binding: completed submissions and later scan completion have separate lifecycles. Adding an unused task table would not close the protocol gap.

## Compatibility details

| Area          | 2025-era client                                                       | 2026-07-28 client                                     |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Opening       | `initialize`; official v1 client test retained                        | `server/discover`; official v2 client pinned test     |
| HTTP entry    | v2 `createMcpHandler` stateless legacy mode                           | v2 `createMcpHandler` per-request modern mode         |
| Stdio entry   | v2 `serveStdio` connection-pinned legacy mode                         | v2 `serveStdio` connection-pinned modern mode         |
| Routing       | JSON-RPC method in request body                                       | SDK verifies method/name headers against request body |
| Results       | Legacy result encoding                                                | SDK modern envelope and result encoding               |
| Authorization | Hosted app verifies bearer, origin, and workspace before this handler | Same app boundary; no credential or scope shortcut    |

The SDK does not enable list caching, extensions, or optional client requests for LyraShield. The hosted route still owns OAuth issuer/audience checks; those checks are not moved into this package. Exact packaged stdio and deployed-client compatibility remain release gates.

OAuth discovery and authorization are owned by the hosted app routes, outside this publishable package. This package neither weakens nor duplicates those checks.

## Verification

Run `pnpm --filter @lyrashield/mcp test`, `pnpm --filter @lyrashield/mcp typecheck`, and `pnpm --filter @lyrashield/mcp build` before release. These package checks do not establish hosted OAuth or deployed-client behavior.
