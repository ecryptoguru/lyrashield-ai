# Seamless agent integrations evidence ledger — 2026-09-08

Baseline SHA: `76587a358524ce884c43e3e63938d05e499be029`. Implementation commit: `e861fda966b008cb47035c267aa8f6a4fb08b3f6`. Merged product SHA: `21f31fdb1e6386acdb7fb85bb85aa8855b7d4d50`. Pull request: [#630](https://github.com/ecryptoguru/lyrashield-ai/pull/630).

This ledger separates code, CI, deployment, package, and native-client evidence. PR #630 is merged and deployed. Hosted production acceptance passed; package and native-client acceptance remain separate gates.

## Engineering status

| Area                               | Local state   | Evidence                                                                                                                                                                                                                                                                           | Remaining gate                                                                                     |
| ---------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Credential lifecycle               | CODE_VERIFIED | Dynamic SDK credentials stop using a removed token; credential writes use an owner-bound lock; focused and full repository tests pass.                                                                                                                                             | Released-package running-client refresh/logout proof.                                              |
| Connection storage and RLS         | DEPLOYED      | All 81 migrations applied to an isolated PostgreSQL database. Restricted-role RLS tests passed locally and in exact-head CI; the additive migration then applied successfully in production.                                                                                       | Native lifecycle receipts remain separate.                                                         |
| Delegated authorization            | DEPLOYED      | One canonical operation catalog drives consent, REST permission checks, and MCP execution. Empty mutation grants, missing target scope, disallowed profiles, unknown mutations, expiry, and cross-workspace access fail closed.                                                    | Authenticated native-client lifecycle proof.                                                       |
| Idempotent execution               | DEPLOYED      | Caller-supplied idempotency keys are required for delegated mutations. Pending/executing work does not execute again; completed work replays its stored result; failed/conflicting work fails closed.                                                                              | Deployed concurrent-call and crash-recovery operational receipt.                                   |
| OAuth binding and lifecycle        | DEPLOYED      | Tokens bind to connection ID, authorization version, workspace, user, OAuth client, scopes, expiry, targets, operations, and profiles. Pause/revoke/version mismatch and permission loss are checked server-side.                                                                  | Real authorize, consent, refresh, revoke, reconnect, permission-loss, and concurrent-tab journeys. |
| Consent UX                         | DEPLOYED      | Read-only is the default. Automation is available only when the client requested write scope and requires explicit workflow, target, and billable-profile selection. Target IDs are verified in the selected workspace. Production build and unauthenticated discovery smoke pass. | Authenticated accessibility and mobile/desktop acceptance.                                         |
| REST and MCP parity                | DEPLOYED      | Scan, report, fix-proposal, retest, and fix-PR routes enforce connection scope. Delegated MCP schemas advertise a required idempotency key without review-queue fields; legacy reviewed mode retains `approvalId`.                                                                 | Released-package and authenticated live parity receipts.                                           |
| CLI and installers                 | PUBLISHED     | `connect` uses registry IDs and reports preview, configured-unverified, connected, manual, delegated, and failed outcomes truthfully with aligned text/JSON exits. Fresh registry-only installs of CLI 0.2.5 and MCP 0.2.6 pass version and initialize smoke.                      | Install/connect/restart/upgrade proof in each native host.                                         |
| Registry, generated plugin, WebMCP | PUBLISHED     | Agent Plugin 0.1.25 generates and validates 31 deterministic marketplace artifacts; npm import passes; marketplace `v0.1.25` and hosted OAuth discovery/MCP bearer challenge are live.                                                                                             | Browser/native runtime receipts.                                                                   |
| Release closeout                   | RELEASED      | Exact PR and merged-main CI passed. Product SHA `60ced68c` deployed through migration, candidate smoke, queue-empty check, traffic promotion, production smoke, and worker promotion. npm packages and marketplace `v0.1.25` are published.                                        | Native lifecycle matrix.                                                                           |

## Current local verification

- `pnpm typecheck`: 36/36 tasks passed.
- `pnpm lint`: 34/34 tasks passed with zero warnings.
- `pnpm test`: 3,545 tests passed; 45 existing tests were skipped by their suites.
  - Core: 3,370 passed, 45 skipped.
  - Marketing: 151 passed.
  - Motion: 18 passed.
  - Operations: 6 passed.
- `pnpm build`: 11/11 build tasks passed, including the Next.js production build and all 110 static-page generations.
- `pnpm format:check`: passed.
- `pnpm prisma:migrate:check`: no migration/schema difference.
- `git diff --check`: passed.
- Focused authorization, OAuth, MCP, connection, CLI, SDK, credentials, and route regressions pass.

One API parity test exceeded its five-second timeout only when the full test suite ran concurrently with full lint. It passed alone in 1.93 seconds, and the subsequent sequential full-suite run passed. This is recorded as a resource-contention observation, not a product failure.

## Native lifecycle acceptance

No native-client cell is marked accepted for the new package release candidate. Unit tests, registry fixtures, terminal probes, and earlier releases do not establish current native lifecycle behavior.

| Client surface                   | Install/connect/read/write | Refresh | Revoke  | Permission loss | Restart | Upgrade | Current state                                                  |
| -------------------------------- | -------------------------- | ------- | ------- | --------------- | ------- | ------- | -------------------------------------------------------------- |
| Codex Desktop                    | PENDING_LIVE_ACCEPTANCE    | PENDING | PENDING | PENDING         | PENDING | PENDING | Exact packages and hosted OAuth/API/MCP revision are released. |
| Claude Chat Free                 | PENDING_LIVE_ACCEPTANCE    | PENDING | PENDING | PENDING         | PENDING | PENDING | Separate surface from Claude Code desktop-host acceptance.     |
| Claude Code through desktop host | BLOCKED_ACCOUNT_CAPABILITY | BLOCKED | BLOCKED | BLOCKED         | BLOCKED | BLOCKED | The available Free account does not provide Claude Code.       |
| Devin IDE                        | PENDING_LIVE_ACCEPTANCE    | PENDING | PENDING | PENDING         | PENDING | PENDING | Exact packages and hosted revision are released.               |
| Antigravity                      | PENDING_LIVE_ACCEPTANCE    | PENDING | PENDING | PENDING         | PENDING | PENDING | Exact packages and hosted revision are released.               |
| OpenCode                         | PENDING_LIVE_ACCEPTANCE    | PENDING | PENDING | PENDING         | PENDING | PENDING | Exact packages and hosted revision are released.               |
| Hermes                           | PENDING_LIVE_ACCEPTANCE    | PENDING | PENDING | PENDING         | PENDING | PENDING | Exact packages and hosted revision are released.               |

All other registry clients remain `PENDING_LIVE_ACCEPTANCE` until their documented native path is exercised with client version, OS version, package version, source SHA, transport, sanitized results, and cleanup evidence.

## Release evidence

Published npm integrity receipts:

- `lyrashield@0.2.5`: `sha512-xSkpa/r1D2QBPNVcCZUqOEOfL5vnVaYDHamsnPBMQwFCAxUQKbCGo3mpep/zksKf08gOLmJAGDmOAuE8LM7ybQ==`
- `@lyrashield/mcp@0.2.6`: `sha512-q30vSuQk5vPLRsZz8prjEI3+ny1Ouanx4idtTKzxzylrNX+YmZeACip08PG/MKIuGIid6djqT/b7dxRvOZKksA==`
- `@lyrashield/agent-plugin@0.1.25`: `sha512-CLR655OISFnxSYTi8PygMmaaBXoeDwDPaVd5PK5NsPcf19kPZ/36qffgdC4f9cLigBPf01Ylcb0YQkatXDRsYw==`
- Marketplace tag `v0.1.25`: `65d30095614d1603c8e1d37abcfefc5dfe9d0e91`

| Gate                                   | State                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit containing this implementation  | `e861fda966b008cb47035c267aa8f6a4fb08b3f6`                                                                                                                     |
| Pull request and exact-head CI         | PR #630 merged; exact-head CI passed                                                                                                                           |
| Merged-main CI                         | PASS — run `34250225770`                                                                                                                                       |
| Package publication                    | PASS — npm CLI `0.2.5` (`sha512-xSkpa/…`), MCP `0.2.6` (`sha512-q30vS…`), Agent Plugin `0.1.25` (`sha512-CLR65…`); marketplace `v0.1.25` at `65d30095`         |
| Database deployment                    | PASS — additive migration applied                                                                                                                              |
| Application deployment revision/digest | PASS — run `34256763208`; app `0000323`, scanner `0000296`, egress `0000164`, worker `sha256:a18630db1b0533237f681f1cff848ab4daefa125a38fc3334fa9038608c68259` |
| Live OAuth/API/MCP/WebMCP smoke        | PASS for health, readiness, discovery, protected-resource metadata, and unauthenticated bearer challenge                                                       |
| Native lifecycle matrix                | PENDING/BLOCKED as listed above                                                                                                                                |

Hosted code is deployed and healthy, and exact packages are published. Native lifecycle acceptance must still be established independently.
