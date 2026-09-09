# Product-simplification execution ledger — 2026-09-09

Companion to [`2026-09-09-product-simplification-coding-handoff.md`](./2026-09-09-product-simplification-coding-handoff.md).
States: `not started` → `implemented` → `locally verified` → `CI verified` → `deployed` → `operationally accepted`, or `blocked: <exact dependency>`.
A local green test does not fill deployment or client columns. Source: PR #638 (merged, main `4671ad11`) for Waves 1–3 core; this session's follow-up wave (W2-05/07/11/12, W3-03/05/06) is the follow-up PR based on main `4671ad11` (with #639's ledger note merged).

## Baseline receipts (this session)

| Check                         | Result                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fetch/PR state                | #637 OPEN, MERGEABLE, head `527fec56` at session start; all CI checks SUCCESS                                                                          |
| Local typecheck (after waves) | 36/36 turbo tasks successful                                                                                                                           |
| Local lint (after waves)      | 34/34 turbo tasks successful                                                                                                                           |
| Core tests (after waves)      | 3,522 passed / 46 skipped (env-dependent) / 0 failed                                                                                                   |
| Build                         | 11/11 turbo tasks successful                                                                                                                           |
| `format:check`                | Formatting clean; the command errors only because `git ls-files` still lists the intentionally deleted docs files — commit the deletions to restore it |
| `git diff --check`            | clean                                                                                                                                                  |
| DB runtime + RLS              | blocked: isolated migrated database with a nonsuperuser/non-BYPASSRLS role not provisioned in this session; required before merge per handoff §8       |
| Playwright browser proof      | blocked: not run this session; required before merge for the touched surfaces                                                                          |

## Follow-up session receipts (2026-09-09, remaining tasks)

| Check                           | Result                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Core tests                      | 3,563 passed / 46 skipped / 0 failed (406 files)                                                                     |
| Marketing tests                 | 152 passed / 0 failed                                                                                                |
| Typecheck / lint / format       | all green (turbo 36/36, 34/34; prettier clean)                                                                       |
| Migration drift check           | clean                                                                                                                |
| Isolated-DB RLS runtime         | rls-fail-closed 26/26 + gate-service runtime 8/8 against migrated DB with `app_runtime_ci` (NOSUPERUSER/NOBYPASSRLS) |
| Playwright non-visual suite     | 37 passed / 0 failed (local, production-mode standalone server)                                                      |
| Playwright visual/mobile        | 3/3 passed on regenerated baselines (mobile, tablet, desktop)                                                        |
| `git diff --check`              | clean                                                                                                                |
| Real-browser WebMCP conformance | blocked: no available browser exposes `document.modelContext` (Chromium 1.62.1 ± flags)                              |
| Coding-agent client acceptance  | founder-dependent; per-surface receipts pending                                                                      |

## Task ledger

| Task   | Source SHA/PR | Regression or fixture                                              | Local checks               | PR-head CI | Merged/deployed revision | Runtime/client receipt | Remaining limitation                                                                               |
| ------ | ------------- | ------------------------------------------------------------------ | -------------------------- | ---------- | ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------- |
| W1-01  | `a900e4ef`    | terminology.test.ts (noun contract + source sweep)                 | typecheck/lint/tests green | pending    | —                        | —                      | URL params (`tab=issues`) kept for compatibility                                                   |
| W1-02  | `a900e4ef`    | home-next-action.test.ts (one decision, panel+CTA coherence)       | green                      | pending    | —                        | —                      | mobile rendering asserted via model, not pixels                                                    |
| W1-03  | `a900e4ef`    | gate-state fixtures (READY/NOT_READY/INSUFFICIENT)                 | green                      | pending    | —                        | —                      | —                                                                                                  |
| W1-04  | `a900e4ef`    | postureVerdict gate-first contract                                 | green                      | pending    | —                        | —                      | —                                                                                                  |
| W1-05  | `a900e4ef`    | dashboard page restructure; metrics reduced to 3                   | green                      | pending    | —                        | —                      | 390px overflow check pending Playwright run                                                        |
| W1-06  | `b0c17b33`    | shell-regressions.test.ts (alert + retry, both shells)             | green                      | pending    | —                        | —                      | —                                                                                                  |
| W1-07  | `b4d3993f`    | operation-failure.test.ts (17 reason codes, no-leak)               | green                      | pending    | —                        | —                      | wired to latest-scan alert; other origins reuse helper                                             |
| W1-08  | `c4023415`    | team-permissions.contract.test.tsx (UI/API projection)             | green                      | pending    | —                        | —                      | —                                                                                                  |
| W1-09  | `2962f918`    | approvals page + nav Activity item; URL preserved                  | green                      | pending    | —                        | —                      | —                                                                                                  |
| W1-10  | `2962f918`    | shared scan presentation reused at origins; live regions present   | green                      | pending    | —                        | —                      | screen-reader pass pending browser proof                                                           |
| W2-01  | `575a52f0`    | workspace-creation service reuse; slug-conflict adoption           | green                      | pending    | —                        | —                      | —                                                                                                  |
| W2-02  | `f3ad39f6`    | targetNameFromUrl tests; TARGET_EXISTS typed response              | green                      | pending    | —                        | —                      | —                                                                                                  |
| W2-03  | `f3ad39f6`    | environment selector removed from critical path                    | green                      | pending    | —                        | —                      | —                                                                                                  |
| W2-04  | `d909588d`    | one recommended review; Change review disclosure                   | green                      | pending    | —                        | —                      | eligibility preflight parity fixtures pending                                                      |
| W2-05  | `6c5b90e6`    | signed OAuth return state (HMAC+expiry+user) + consent redirect    | green                      | pending    | —                        | —                      | GitHub-install round-trip does not carry the OAuth return state; recorded limitation               |
| W2-06  | `575a52f0`    | partial: server self-heals workspace pointers; step clamp          | green                      | pending    | —                        | —                      | full multi-tab/revoked-install matrix pending                                                      |
| W2-07  | `583970fd`    | home decision carries target; stale target params invalidated      | green                      | pending    | —                        | —                      | last-successful per-target review-choice memory still pending                                      |
| W2-08  | `f4480caf`    | connections page; nav complement tests                             | green                      | pending    | —                        | —                      | —                                                                                                  |
| W2-09  | `f4480caf`    | partial: status/scopes/expiry/read-write usability shown           | green                      | pending    | —                        | —                      | last-successful-operation timestamp not surfaced yet                                               |
| W2-10  | `cf94958d`    | reports page + redirect + nav complement tests                     | green                      | pending    | —                        | —                      | —                                                                                                  |
| W2-11  | `66363b54`    | settings-split contract test (5 cases); admin gates preserved      | green                      | pending    | —                        | —                      | —                                                                                                  |
| W2-12  | `12fdd48f`    | findings-context contract test (5 cases); sessionStorage snapshot  | green                      | pending    | —                        | —                      | —                                                                                                  |
| W3-01  | `4531fc45`    | principal identity tests; opt-in Idempotency-Key on scan create    | green                      | pending    | —                        | —                      | DB runtime/RLS suite pending isolated DB; REST coverage for retest/fix/report routes not yet wired |
| W3-02  | `e10bd32c`    | finding-next-action.test.ts (12 cases)                             | green                      | pending    | —                        | —                      | UI wiring of the secondary menu pending                                                            |
| W3-03  | `749fe317`    | remediation-timeline tests (7 cases); PR receipts in getFinding    | green                      | pending    | —                        | —                      | —                                                                                                  |
| W3-04  | `143ea0af`    | webhook regressions (duplicate/unrelated/unmerged/budget/no-merge) | green                      | pending    | —                        | —                      | deployed-behavior verification pending release                                                     |
| W3-05  | `644b70ce`    | snapshot-reuse + failed-scan verdict tests (33 report tests)       | green                      | pending    | —                        | —                      | concurrent duplicate creation not DB-constrained (app-level policy)                                |
| W3-06  | `a26101a0`    | grouping-policy tests (7 cases); worker hourly routine group       | green                      | pending    | —                        | —                      | —                                                                                                  |
| W3-07  | `42cbe67c`    | durable tool + receipt classification; prepare tool unchanged      | green                      | pending    | —                        | —                      | real-browser conformance pending                                                                   |
| W3-08  | `db572f2b`    | status contract + GET route + pure mapping tests                   | green                      | pending    | —                        | —                      | CLI/MCP renderers not yet consuming the shared shape                                               |
| CR-1/2 | `d45c2b00`    | consent-state module + route/form tests (29 tests)                 | green                      | pending    | —                        | —                      | —                                                                                                  |
| CR-3   | `49c556ec`    | validator self-tests incl. negative drift fixtures                 | green                      | pending    | —                        | —                      | —                                                                                                  |
| CR-4   | `49c556ec`    | permissions.test.ts Option-3 block; ledger note                    | green                      | pending    | —                        | —                      | founder decision recorded here and in test comment                                                 |
| CR-5   | `49c556ec`    | oauth-login failure-mapping tests                                  | green                      | pending    | —                        | —                      | —                                                                                                  |
| CR-6   | `49c556ec`    | doc alignment across 6 files                                       | green                      | pending    | —                        | —                      | —                                                                                                  |

## Blocked dependencies (recorded, not silently dropped)

- **Deleted docs vs CI**: the intentional working-tree deletion of 43 docs files must be committed (or restored) before PR-head CI; `format:check` currently fails on the missing tracked paths.
- **DB runtime + RLS suite**: passed locally on 2026-09-09 against a migrated database with the restricted `app_runtime_ci` (NOSUPERUSER, NOBYPASSRLS) role — rls-fail-closed (26 tests) and gate-service runtime (8 tests) green; CI runs the same suite on every PR head.
- **Real-browser WebMCP conformance**: no locally available browser build exposes `document.modelContext` (verified with Playwright Chromium 1.62.1, with and without feature flags); the register layer's feature-detect degradation is unit-tested and the durable execution path is server-tested. Blocked on a browser build with native WebMCP.
- **Paid acceptance** (Deep/Terra, live payments), production deployment, marketplace publication: founder authorization required.
- **Coding-agent client acceptance** (Codex, Claude Chat, Devin, Antigravity, OpenCode, Hermes): per-surface receipts pending; blocked rows stay blocked.
- **Visual baselines**: regenerated 2026-09-09 from the simplified dashboard after visual inspection (mobile/tablet/desktop); the suite passes cleanly against them.
- Platform-affiliate mutations remain disabled (separate initiative).

## Route/navigation map (current branch state)

- Primary (desktop): Home, Targets, Scans, Findings, **Reports** (new direct destination).
- Mobile bottom bar: Home, Targets, Scans, Findings + More sheet (Reports, Connections, Notifications, Fixes, Team, Settings, Billing*, Activity*, Evidence Vault*, Platform Admin* — *permission/conditional).
- `/dashboard/connections`: new consolidated destination (connected clients first, catalog second).
- Preserved URLs: `/dashboard/runs`→scans, `/dashboard/issues`→findings, `/dashboard/fixes` (alternate view), `/dashboard/agents` + `/dashboard/integrations` (install catalog), `/dashboard/approvals` (Activity), `findings?tab=reports`→`/dashboard/reports` (query scope forwarded).
