# Seamless agent integrations evidence ledger — 2026-09-08

Baseline SHA: `76587a358524ce884c43e3e63938d05e499be029`. Working branch: `codex/integration-automation-research-2026-09-08`.

This ledger separates local code evidence from PR, release, deployment, and native-client evidence. The implementation is a branch candidate over the baseline SHA; the pull request records the exact candidate head. The baseline SHA does not contain these changes.

## Engineering status

| Area                               | Local state          | Evidence                                                                                                                                                                                                                                                                                               | Remaining gate                                                                                                    |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Credential lifecycle               | VERIFIED_IN_WORKTREE | Dynamic SDK credentials stop using a removed token; credential writes use an owner-bound lock; focused and full repository tests pass.                                                                                                                                                                 | Exact PR-head CI, package release, running-client refresh/logout proof.                                           |
| Connection storage and RLS         | VERIFIED_IN_WORKTREE | All 81 migrations applied to an isolated PostgreSQL database. A `NOSUPERUSER` restricted role saw zero rows without workspace context, saw only its workspace with context, could not update another workspace, and PostgreSQL rejected a cross-workspace insert. Migration/schema drift check passes. | Exact PR-head CI and deployed migration proof.                                                                    |
| Delegated authorization            | VERIFIED_IN_WORKTREE | One canonical operation catalog drives consent, REST permission checks, and MCP execution. Empty mutation grants, missing target scope, disallowed profiles, unknown mutations, expiry, and cross-workspace access fail closed.                                                                        | Exact PR-head CI and deployed runtime proof.                                                                      |
| Idempotent execution               | VERIFIED_IN_WORKTREE | Caller-supplied idempotency keys are required for delegated mutations. Pending/executing work does not execute again; completed work replays its stored result; failed/conflicting work fails closed.                                                                                                  | Database concurrency and crash-recovery acceptance on the deployed revision.                                      |
| OAuth binding and lifecycle        | VERIFIED_IN_WORKTREE | Tokens bind to connection ID, authorization version, workspace, user, OAuth client, scopes, expiry, targets, operations, and profiles. Pause/revoke/version mismatch and permission loss are checked server-side.                                                                                      | Real authorize, consent, token, refresh, revoke, reconnect, and concurrent-tab journeys on the deployed revision. |
| Consent UX                         | VERIFIED_IN_WORKTREE | Read-only is the default. Automation is available only when the client requested write scope and requires explicit workflow, target, and billable-profile selection. Target IDs are verified in the selected workspace. The pure workflow catalog is browser-safe; the production web build passes.    | Browser accessibility and mobile/desktop acceptance against the deployed page.                                    |
| REST and MCP parity                | VERIFIED_IN_WORKTREE | Scan, report, fix-proposal, retest, and fix-PR routes enforce connection scope. Delegated MCP schemas advertise a required idempotency key without review-queue fields; legacy reviewed mode retains `approvalId`.                                                                                     | Live remote MCP and REST parity on released packages.                                                             |
| CLI and installers                 | VERIFIED_IN_WORKTREE | `connect` uses registry IDs and reports preview, configured-unverified, connected, manual, delegated, and failed outcomes truthfully with aligned text/JSON exits.                                                                                                                                     | Released-package install/connect/restart/upgrade proof in each native host.                                       |
| Registry, generated plugin, WebMCP | BASELINE_TESTED      | Existing repository suites pass for these unchanged or indirectly affected areas.                                                                                                                                                                                                                      | Reproducible export/release identity and browser/native runtime receipts remain separate.                         |
| Release closeout                   | LOCAL_CHECKS_GREEN   | Typecheck, lint, full tests, production build, formatting, migration drift, and diff checks pass locally.                                                                                                                                                                                              | Commit, PR, exact-head CI, merge, deploy, release, and post-deploy acceptance.                                    |

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

No native-client cell is marked accepted for this unreleased working tree. Unit tests, registry fixtures, terminal probes, and earlier releases do not establish current native lifecycle behavior.

| Client surface                   | Install/connect/read/write | Refresh | Revoke  | Permission loss | Restart | Upgrade | Current state                                                  |
| -------------------------------- | -------------------------- | ------- | ------- | --------------- | ------- | ------- | -------------------------------------------------------------- |
| Codex Desktop                    | PENDING_EXACT_RELEASE      | PENDING | PENDING | PENDING         | PENDING | PENDING | Requires released package and deployed OAuth/API/MCP revision. |
| Claude Chat Free                 | PENDING_EXACT_RELEASE      | PENDING | PENDING | PENDING         | PENDING | PENDING | Separate surface from Claude Code desktop-host acceptance.     |
| Claude Code through desktop host | BLOCKED_ACCOUNT_CAPABILITY | BLOCKED | BLOCKED | BLOCKED         | BLOCKED | BLOCKED | The available Free account does not provide Claude Code.       |
| Devin IDE                        | PENDING_EXACT_RELEASE      | PENDING | PENDING | PENDING         | PENDING | PENDING | Requires released package and deployed revision.               |
| Antigravity                      | PENDING_EXACT_RELEASE      | PENDING | PENDING | PENDING         | PENDING | PENDING | Requires released package and deployed revision.               |
| OpenCode                         | PENDING_EXACT_RELEASE      | PENDING | PENDING | PENDING         | PENDING | PENDING | Requires released package and deployed revision.               |
| Hermes                           | PENDING_EXACT_RELEASE      | PENDING | PENDING | PENDING         | PENDING | PENDING | Requires released package and deployed revision.               |

All other registry clients remain `PENDING_EXACT_RELEASE` until their documented native path is exercised with client version, OS version, package version, source SHA, transport, sanitized results, and cleanup evidence.

## Release evidence

| Gate                                   | State                           |
| -------------------------------------- | ------------------------------- |
| Commit containing this implementation  | PENDING                         |
| Pull request and exact-head CI         | PENDING                         |
| Merged-main CI                         | PENDING                         |
| Package publication                    | PENDING                         |
| Database deployment                    | PENDING                         |
| Application deployment revision/digest | PENDING                         |
| Live OAuth/API/MCP/WebMCP smoke        | PENDING                         |
| Native lifecycle matrix                | PENDING/BLOCKED as listed above |

The code can proceed to review once committed. It must not be described as deployed, released, or operationally accepted until those separate receipts exist.
