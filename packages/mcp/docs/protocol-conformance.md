# MCP protocol conformance

Baseline: `@modelcontextprotocol/sdk` **1.30.1** and `@lyrashield/mcp` 0.2.9. The SDK
floor is `^1.30.1` in `packages/mcp` and `packages/cli` (the CLI uses the SDK as an MCP
client); `pnpm-lock.yaml` resolves `1.30.1` with integrity
`sha512-H2HxLvC3HDNybePJaLdSrU1hhUK5iQw+WvV1b01myFyI7sdVGe1u/IPTE5D9fGCiJDVtgMV/lmFkQXLmQyIFYA==`.

## SDK version decision

- npm `@modelcontextprotocol/sdk` has exactly one dist-tag, `latest: 1.30.1` — there is
  no beta channel. The `1.30.0` → `1.30.1` patch adds a bounded HTTP request-body read
  (4 MiB default → HTTP 413), a 100-message JSON-RPC batch cap (→ HTTP 400), and an
  auth resource-URI fix. `dist/esm/types.js` is byte-identical between the two:
  `LATEST_PROTOCOL_VERSION` stays `2025-11-25` and `SUPPORTED_PROTOCOL_VERSIONS` stays
  `["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]` — verified
  by importing the installed package and asserted in `src/protocol.test.ts`.
- 1.30.1 was published 2026-09-23, inside the repo's 7-day `minimumReleaseAge` gate, so
  `pnpm-workspace.yaml` carries an explicit `minimumReleaseAgeExclude` entry with the
  reason recorded inline.

## Compatibility matrix

Every claim below is executable; the cited test files are the evidence.

### Negotiated protocol versions

| Guarantee                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` negotiates via `initialize` and is echoed verbatim                                                                                                                                                                      | `src/http-transport.test.ts` (`it.each(SUPPORTED_PROTOCOL_VERSIONS)`), `src/packed-stdio.test.ts` (same matrix on the packed npm tarball over real stdio) |
| `initialize` requesting an unknown or future version (`2026-07-28`, `1999-01-01`, `not-a-version`, `""`) is answered with `2025-11-25` — per the spec the server replies with a version it supports and the client disconnects if it cannot speak it; the server never echoes an unsupported version | `src/http-transport.test.ts`, `src/packed-stdio.test.ts`                                                                                                  |

### Transport behaviors

| Guarantee                                                                                                                                                                                                                                                | Evidence                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `initialize` returns server metadata (name, title, version, description, website) and usage instructions                                                                                                                                                 | `src/create-server.test.ts`, `src/http-transport.test.ts`, `src/packed-stdio.test.ts`    |
| `tools/list` returns all 15 tools, each with title, input/output JSON schemas, safety annotations and `execution.taskSupport: "forbidden"`                                                                                                               | `src/create-server.test.ts`, `src/http-transport.test.ts`, `src/packed-stdio.test.ts`    |
| `tools/call` runs read-only tools; mutating tools fail closed without an approval path (stateless HTTP denies by default; `allowMutations` is explicit opt-in only)                                                                                      | `src/http-transport.test.ts`, `src/create-server.test.ts`, `src/server-approval.test.ts` |
| JSON-RPC batching is supported and bounded: a 2-message batch returns both answers; a batch over 100 messages is refused with HTTP 400 `-32600`; a batch containing `initialize` plus other messages is refused with HTTP 400 `-32600`                   | `src/http-transport.test.ts`                                                             |
| Malformed JSON bodies and non-JSON-RPC payloads fail closed with HTTP 400 `-32700`; non-JSON `Content-Type` → 415; `Accept` missing either required media type → 406; request bodies over the 4 MiB SDK bound → 413; verbs outside POST/GET/DELETE → 405 | `src/http-transport.test.ts`                                                             |

### Request metadata and routing headers

| Guarantee                                                                                                                                                                                                                                                   | Evidence                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `MCP-Protocol-Version` on non-initialize requests must be SDK-supported: `2026-07-28`, `1999-01-01`, `not-a-version`, `1.0`, `../etc/passwd` are rejected HTTP 400 `-32000` naming every supported version; an absent header follows the negotiated default | `src/http-transport.test.ts`                                 |
| `Mcp-Session-Id` and `Last-Event-ID` are ignored — the transport is stateless (`sessionIdGenerator: undefined`, no event store), so a caller-claimed session changes nothing                                                                                | `src/http-transport.test.ts`                                 |
| `Authorization` is never read by this package; the hosted route authenticates Bearer API keys and OAuth tokens and returns 401 with `WWW-Authenticate` + protected-resource metadata                                                                        | `src/http-transport.ts`, `apps/web/src/app/api/mcp/route.ts` |

### OAuth boundary ownership

OAuth discovery and authorization are owned by the hosted app routes (`/oauth/consent`,
`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`),
outside this publishable package. The package only receives an already-authenticated
tool context; delegated-OAuth binding, `connect_required` responses and the idempotency
ledger are exercised in `src/remote-approval.test.ts` and
`apps/web/src/app/api/mcp/route.ts`. This package neither weakens nor duplicates those
checks.

### Cache policy

| Guarantee                                                                                                            | Evidence                                            |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Hosted responses are `Cache-Control: no-store, no-transform` and `Vary: Accept, Authorization, MCP-Protocol-Version` | `src/http-transport.test.ts`                        |
| No list-cache metadata (`ttlMs` / `cacheScope`) is advertised on any list result                                     | `src/protocol.test.ts` (`listCacheMetadata: false`) |

### Unsupported methods and features

| Item                                                               | Behavior                                                                                                           | Reason unsupported                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `server/discover`                                                  | JSON-RPC `-32601 Method not found`                                                                                 | No stable SDK ≤1.30.1 — `src/http-transport.test.ts`, `src/packed-stdio.test.ts`                                           |
| `resources/list`, `prompts/list`, `completion/complete`, `tasks/*` | JSON-RPC `-32601 Method not found`                                                                                 | Intentionally not enabled — no such server capability is registered (`src/create-server.ts`); `src/http-transport.test.ts` |
| MRTR retry/input-response exchange                                 | Not implemented                                                                                                    | No stable SDK ≤1.30.1 exposes it; not emulated (`src/protocol.test.ts`)                                                    |
| `Mcp-Method` / `Mcp-Name` transport headers                        | Not consumed                                                                                                       | No stable SDK ≤1.30.1 reads them (`src/protocol.test.ts`)                                                                  |
| List-result `ttlMs` / `cacheScope`                                 | Not advertised                                                                                                     | No stable SDK ≤1.30.1 schema (`src/protocol.test.ts`)                                                                      |
| Protocol version `2026-07-28`                                      | **Blocked — recorded, not emulated** (see receipt below)                                                           | No stable SDK ≤1.30.1 supports it                                                                                          |
| MCP Tasks (`experimental/tasks`, protocol `2025-11-25`)            | Intentionally not enabled; tools declare `execution.taskSupport: "forbidden"` and server capabilities omit `tasks` | `src/create-server.test.ts`; rationale below                                                                               |

## Blocked feature receipt: protocol `2026-07-28`

The MCP specification dated `2026-07-28` is published, but as of
`@modelcontextprotocol/sdk` **1.30.1** — the newest stable release on npm — no stable
SDK supports negotiating it: `SUPPORTED_PROTOCOL_VERSIONS` ends at `2025-11-25`.
LyraShield therefore does **not** hand-emulate `2026-07-28` semantics. Fail-closed
behavior is verified instead:

- `initialize` requesting `2026-07-28` is answered with `2025-11-25`, never the unknown
  version — the client decides whether to continue (`src/http-transport.test.ts`,
  `src/packed-stdio.test.ts`, including the packed npm artifact over real stdio).
- Any non-initialize request bearing `MCP-Protocol-Version: 2026-07-28` is rejected
  HTTP 400 `-32000` with the full supported-version list (`src/http-transport.test.ts`).

This stays blocked until a stable SDK release negotiates `2026-07-28`; the
parameterized matrix above then picks it up automatically from
`SUPPORTED_PROTOCOL_VERSIONS`.

## Intentionally deferred: MCP Tasks

SDK 1.30.x ships `experimental/tasks` for protocol `2025-11-25`. LyraShield does not
enable it: local in-memory task storage would not survive process exit, while the
hosted endpoint creates a fresh server per request. Existing scans already return a
durable LyraShield scan ID and expose safe polling through `lyrashield_get_scan_status`.
Protocol task support waits on a shared durable task adapter and explicit cancellation
semantics that never replay ambiguous paid work (`src/create-server.test.ts`,
`src/server.ts`).

## Test evidence

- The negotiation matrix and every fail-closed assertion are parameterized on the
  installed SDK's own `SUPPORTED_PROTOCOL_VERSIONS` / `LATEST_PROTOCOL_VERSION`
  constants, so the table above tracks SDK upgrades automatically.
- `src/packed-stdio.test.ts` exercises the packed npm tarball (`pnpm pack` → extract →
  spawn `bin/lyrashield-mcp.mjs`) rather than the source tree, under a synthetic `HOME`
  and an unreachable loopback `LYRASHIELD_API_URL`.
- GREEN: `pnpm --filter @lyrashield/mcp exec vitest run src/http-transport.test.ts src/packed-stdio.test.ts src/protocol.test.ts src/create-server.test.ts src/server-approval.test.ts src/remote-approval.test.ts`.
- Full validation commands and final counts belong in the implementation handoff
  because counts can change as the suite grows.
