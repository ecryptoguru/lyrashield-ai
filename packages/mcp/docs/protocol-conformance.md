# MCP protocol conformance

Baseline: `@modelcontextprotocol/sdk` **1.31.0** and `@lyrashield/mcp` 0.2.12. The SDK
floor is `^1.31.0` in `packages/mcp` and `packages/cli` (the CLI uses the SDK as an MCP
client); `pnpm-lock.yaml` resolves `1.31.0` with integrity
`sha512-UvTMgnNlnIBO/22ob2RcVGDlcvOslQs8T59+FTGdA0L27a39fdGF/EDETNtDVK4DZGpwomlsYpRdA8UXcVL/pw==`.

## SDK version decision

- At the npm registry snapshot on 2026-10-06, the SDK's `latest` dist-tag is 1.32.1
  (published 2026-10-05); 1.32.0 was published 2026-10-02. Both releases are younger
  than the repository's seven-day `minimumReleaseAge: 10080` policy. Version 1.31.0,
  published 2026-09-28, is the patched v1 release for
  [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) and passes
  the age gate without an SDK-specific exclusion, so the workspace resolves to it.
- Importing the locked 1.31.0 package reports `LATEST_PROTOCOL_VERSION` as `2025-11-25`
  and the five supported versions listed below; the MCP package's `src/protocol.test.ts`
  asserts these installed-package values.

## Compatibility matrix

Every claim below is executable; the cited test files are the evidence.

### Negotiated protocol versions

| Guarantee                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` negotiates via `initialize` and is echoed verbatim                                                                                                                                                                      | `src/http-transport.test.ts` (`it.each(SUPPORTED_PROTOCOL_VERSIONS)`), `src/packed-stdio.test.ts` (same matrix on the packed npm tarball over real stdio) |
| `initialize` requesting an unknown or future version (`2026-07-28`, `1999-01-01`, `not-a-version`, `""`) is answered with `2025-11-25` — per the spec the server replies with a version it supports and the client disconnects if it cannot speak it; the server never echoes an unsupported version | `src/http-transport.test.ts`, `src/packed-stdio.test.ts`                                                                                                  |

### Transport behaviors

| Guarantee                                                                                                                                                                                                                                                | Evidence                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` returns server metadata (name, title, version, description, website) and usage instructions                                                                                                                                                 | `src/create-server.test.ts`, `src/http-transport.test.ts`, `src/packed-stdio.test.ts`                                           |
| `tools/list` returns all 21 tools with schemas and safety annotations; without task support all declare `execution.taskSupport: "forbidden"`, while a task-enabled server advertises only `lyrashield_scan_target` as `"optional"`                       | `src/create-server.test.ts`, `src/http-transport.test.ts`, `src/packed-stdio.test.ts`, `apps/web/src/app/api/mcp/tasks.test.ts` |
| Stdio supports task augmentation for `lyrashield_scan_target`; hosted HTTP enables it only for a verified connected OAuth client using protocol `2025-11-25`                                                                                             | `src/local-task-backend.test.ts`, `apps/web/src/app/api/mcp/tasks.test.ts`                                                      |
| `tools/call` runs read-only tools; mutating tools fail closed without an approval path (stateless HTTP denies by default; `allowMutations` is explicit opt-in only)                                                                                      | `src/http-transport.test.ts`, `src/create-server.test.ts`, `src/server-approval.test.ts`                                        |
| JSON-RPC batching is supported and bounded: a 2-message batch returns both answers; a batch over 100 messages is refused with HTTP 400 `-32600`; a batch containing `initialize` plus other messages is refused with HTTP 400 `-32600`                   | `src/http-transport.test.ts`                                                                                                    |
| Malformed JSON bodies and non-JSON-RPC payloads fail closed with HTTP 400 `-32700`; non-JSON `Content-Type` → 415; `Accept` missing either required media type → 406; request bodies over the 4 MiB SDK bound → 413; verbs outside POST/GET/DELETE → 405 | `src/http-transport.test.ts`                                                                                                    |

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

| Item                                                    | Behavior                                                                                                                   | Reason unsupported                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `server/discover`                                       | JSON-RPC `-32601 Method not found`                                                                                         | Not implemented by this server — `src/http-transport.test.ts`, `src/packed-stdio.test.ts`                                  |
| `resources/list`, `prompts/list`, `completion/complete` | JSON-RPC `-32601 Method not found`                                                                                         | Intentionally not enabled — no such server capability is registered (`src/create-server.ts`); `src/http-transport.test.ts` |
| MRTR retry/input-response exchange                      | Not implemented                                                                                                            | Not implemented or emulated by this package (`src/protocol.test.ts`)                                                       |
| `Mcp-Method` / `Mcp-Name` transport headers             | Not consumed                                                                                                               | Not consumed by this server (`src/protocol.test.ts`)                                                                       |
| List-result `ttlMs` / `cacheScope`                      | Not advertised                                                                                                             | Not advertised by this server (`src/protocol.test.ts`)                                                                     |
| Protocol version `2026-07-28`                           | **Blocked — recorded, not emulated** (see receipt below)                                                                   | Absent from the pinned 1.31.0 SDK supported-version list                                                                   |
| MCP Tasks (`experimental/tasks`, protocol `2025-11-25`) | Conditional: stdio; hosted connected OAuth only. Other credentials/protocols omit task capability and keep immediate calls | `src/local-task-backend.test.ts`, `apps/web/src/app/api/mcp/tasks.test.ts`; rationale below                                |

## Blocked feature receipt: protocol `2026-07-28`

The pinned `@modelcontextprotocol/sdk` **1.31.0** reports
`SUPPORTED_PROTOCOL_VERSIONS` as `2025-11-25`, `2025-06-18`, `2025-03-26`,
`2024-11-05` and `2024-10-07`; it does not include `2026-07-28`. LyraShield therefore
does **not** hand-emulate `2026-07-28` semantics. Fail-closed behavior is verified:

- `initialize` requesting `2026-07-28` is answered with `2025-11-25`, never the unknown
  version — the client decides whether to continue (`src/http-transport.test.ts`,
  `src/packed-stdio.test.ts`, including the packed npm artifact over real stdio).
- Any non-initialize request bearing `MCP-Protocol-Version: 2026-07-28` is rejected
  HTTP 400 `-32000` with the full supported-version list (`src/http-transport.test.ts`).

This remains blocked for the pinned SDK until its supported-version list includes
`2026-07-28` and the package's conformance tests pass for that version. The
parameterized matrix above picks up versions listed by the installed SDK automatically.

## Task behavior

Task augmentation is limited to `lyrashield_scan_target`. Stdio resolves task state
through the REST operation and scan ledger; `tasks/list` is limited to that running
process session. The hosted endpoint enables task support only for a connected OAuth
client on protocol `2025-11-25`, derives state from durable operation and scan records
and rechecks the connection, authorization version and target scope for every read or
cancellation. Task IDs are not bearer capabilities and expire after 24 hours. A
`tasks/cancel` request uses the normal `scan:cancel` permission and cannot replay a
scan. Clients using older protocol versions or hosted API keys receive ordinary
immediate-call behavior and poll a returned scan ID with `lyrashield_get_scan_status`.

Evidence: `src/task-adapter.test.ts`, `src/local-task-backend.test.ts`,
`apps/web/src/app/api/mcp/tasks.test.ts` and `apps/web/src/lib/mcp-tasks.ts`.

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
