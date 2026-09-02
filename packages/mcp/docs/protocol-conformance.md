# MCP protocol conformance

Baseline: `@modelcontextprotocol/sdk` 1.30.0 and `@lyrashield/mcp` 0.2.3.

## Supported and tested

| Guarantee                                                                                  | Evidence                                                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Latest SDK stable protocol `2025-11-25` negotiates successfully                            | `src/http-transport.test.ts`                               |
| Previous protocol `2025-06-18` still negotiates successfully                               | `src/http-transport.test.ts`                               |
| Unsupported protocol headers fail with HTTP 400 and list supported versions                | `src/http-transport.test.ts`                               |
| Server metadata and instructions are returned during initialization                        | `src/create-server.test.ts`                                |
| All tools expose title, input/output schemas, annotations, and explicit task semantics     | `src/create-server.test.ts`                                |
| Success and error results expose both text and structured content                          | `src/create-server.test.ts`, `src/server-approval.test.ts` |
| Hosted workspace responses are `no-store` and vary by authorization/protocol               | `src/http-transport.test.ts`                               |
| Read tools bypass approval; write tools remain fail-closed without exact-argument approval | `src/create-server.test.ts`, `src/remote-approval.test.ts` |

## Intentionally unsupported

SDK 1.30.0 does not expose stable server APIs or schemas for these newer draft concepts, so LyraShield does not advertise or emulate them:

- `server/discover`;
- list-result `ttlMs` and `cacheScope` fields;
- `Mcp-Method` and `Mcp-Name` transport headers;
- MRTR retry/input-response exchange;
- the protocol version `2026-07-28`.

SDK 1.30.0 includes experimental MCP Tasks for protocol `2025-11-25`. LyraShield does not enable them yet. Local in-memory task storage would not survive process exit, while the hosted endpoint creates a fresh server per request. Existing scans already return a durable LyraShield scan ID and expose safe polling through `lyrashield_get_scan_status`. Protocol task support must wait for a shared durable task adapter and explicit cancellation semantics that never replay ambiguous paid work.

OAuth discovery and authorization are owned by the hosted app routes, outside this publishable package. This package neither weakens nor duplicates those checks.

## TDD evidence

- RED: focused tests failed on missing protocol support metadata, missing server/tool metadata, cacheable hosted responses, and missing structured error payloads.
- GREEN: `pnpm --filter @lyrashield/mcp exec vitest run src/protocol.test.ts src/create-server.test.ts src/http-transport.test.ts src/server-approval.test.ts`.
- Full validation commands and final counts belong in the implementation handoff because counts can change as the suite grows.
