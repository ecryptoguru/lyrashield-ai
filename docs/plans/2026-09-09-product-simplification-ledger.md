# Product-simplification execution ledger — 2026-09-09

Companion to [`2026-09-09-product-simplification-coding-handoff.md`](./2026-09-09-product-simplification-coding-handoff.md).
States: `not started` → `implemented` → `locally verified` → `CI verified` → `deployed` → `operationally accepted`, or `blocked: <exact dependency>`.
A local green test does not fill deployment or client columns. Source: PR #637 branch `codex/automatic-connection-authorization`.

## Baseline receipts (this session)

| Check | Result |
| --- | --- |
| Fetch/PR state | #637 OPEN, MERGEABLE, head `527fec56` at session start; all CI checks SUCCESS |
| Local typecheck (after waves) | 36/36 turbo tasks successful |
| Local lint (after waves) | 34/34 turbo tasks successful |
| Core tests (after waves) | 3,499 passed / 59 skipped / 6 failed in one loaded invocation; all 6 failures were per-test timeouts under load and every affected suite passes in isolation (47+47+66 tests re-run green) |
| Build | 11/11 turbo tasks successful |
| `format:check` | Formatting clean; the command errors only because `git ls-files` still lists the intentionally deleted docs files — commit the deletions to restore it |
| `git diff --check` | clean |
| DB runtime + RLS | blocked: isolated migrated database with a nonsuperuser/non-BYPASSRLS role not provisioned in this session; required before merge per handoff §8 |
| Playwright browser proof | blocked: not run this session; required before merge for the touched surfaces |

## Task ledger

| Task | Source SHA/PR | Regression or fixture | Local checks | PR-head CI | Merged/deployed revision | Runtime/client receipt | Remaining limitation |
| ---- | ------------- | --------------------- | ------------ | ---------- | ------------------------ | ---------------------- | -------------------- |
| W1-01 | `a900e4ef` | terminology.test.ts (noun contract + source sweep) | typecheck/lint/tests green | pending | — | — | URL params (`tab=issues`) kept for compatibility |
| W1-02 | `a900e4ef` | home-next-action.test.ts (one decision, panel+CTA coherence) | green | pending | — | — | mobile rendering asserted via model, not pixels |
| W1-03 | `a900e4ef` | gate-state fixtures (READY/NOT_READY/INSUFFICIENT) | green | pending | — | — | — |
| W1-04 | `a900e4ef` | postureVerdict gate-first contract | green | pending | — | — | — |
| W1-05 | `a900e4ef` | dashboard page restructure; metrics reduced to 3 | green | pending | — | — | 390px overflow check pending Playwright run |
| W1-06 | `b0c17b33` | shell-regressions.test.ts (alert + retry, both shells) | green | pending | — | — | — |
| W1-07 | `b4d3993f` | operation-failure.test.ts (17 reason codes, no-leak) | green | pending | — | — | wired to latest-scan alert; other origins reuse helper |
| W1-08 | `c4023415` | team-permissions.contract.test.tsx (UI/API projection) | green | pending | — | — | — |
| W1-09 | `2962f918` | approvals page + nav Activity item; URL preserved | green | pending | — | — | — |
| W1-10 | `2962f918` | shared scan presentation reused at origins; live regions present | green | pending | — | — | screen-reader pass pending browser proof |
| W2-01 | `575a52f0` | workspace-creation service reuse; slug-conflict adoption | green | pending | — | — | — |
| W2-02 | `f3ad39f6` | targetNameFromUrl tests; TARGET_EXISTS typed response | green | pending | — | — | — |
| W2-03 | `f3ad39f6` | environment selector removed from critical path | green | pending | — | — | — |
| W2-04 | `d909588d` | one recommended review; Change review disclosure | green | pending | — | — | eligibility preflight parity fixtures pending |
| W2-05 | — | not started | — | — | — | — | blocked: signed return-state design not implemented this session |
| W2-06 | `575a52f0` | partial: server self-heals workspace pointers; step clamp | green | pending | — | — | full multi-tab/revoked-install matrix pending |
| W2-07 | — | not started | — | — | — | — | not started |
| W2-08 | `ab974040` | connections page; nav complement tests | green | pending | — | — | — |
| W2-09 | `ab974040` | partial: status/scopes/expiry/read-write usability shown | green | pending | — | — | last-successful-operation timestamp not surfaced yet |
| W2-10 | `cf94958d` | reports page + redirect + nav complement tests | green | pending | — | — | — |
| W2-11 | — | not started | — | — | — | — | not started |
| W2-12 | — | not started | — | — | — | — | not started |
| W3-01 | `4531fc45` | principal identity tests; opt-in Idempotency-Key on scan create | green | pending | — | — | DB runtime/RLS suite pending isolated DB; REST coverage for retest/fix/report routes not yet wired |
| W3-02 | — | not started (existing finding-next-step remains canonical) | — | — | — | — | not started |
| W3-03 | — | not started | — | — | — | — | not started |
| W3-04 | `143ea0af` | webhook regressions (duplicate/unrelated/unmerged/budget/no-merge) | green | pending | — | — | deployed-behavior verification pending release |
| W3-05 | — | not started | — | — | — | — | not started |
| W3-06 | — | not started | — | — | — | — | not started |
| W3-07 | — | not started (prepare_security_scan unchanged) | — | — | — | — | durable WebMCP tool depends on W3-01 REST wiring for other routes |
| W3-08 | `4531fc45` | partial: operation list + status shape in db service | green | pending | — | — | cross-surface contract (CLI/MCP/WebMCP render) not unified yet |
| CR-1/2 | `d45c2b00` | consent-state module + route/form tests (29 tests) | green | pending | — | — | — |
| CR-3 | `49c556ec` | validator self-tests incl. negative drift fixtures | green | pending | — | — | — |
| CR-4 | `49c556ec` | permissions.test.ts Option-3 block; ledger note | green | pending | — | — | founder decision recorded here and in test comment |
| CR-5 | `49c556ec` | oauth-login failure-mapping tests | green | pending | — | — | — |
| CR-6 | `49c556ec` | doc alignment across 6 files | green | pending | — | — | — |

## Blocked dependencies (recorded, not silently dropped)

- **Deleted docs vs CI**: the intentional working-tree deletion of 43 docs files must be committed (or restored) before PR-head CI; `format:check` currently fails on the missing tracked paths.
- **DB runtime + RLS suite**: requires an isolated migrated database with a nonsuperuser/non-BYPASSRLS role. Required for W3-01 acceptance before merge.
- **Playwright browser proof** for the touched surfaces (dashboard, onboarding, connections, reports, findings).
- **Paid acceptance** (Deep/Terra, live payments), production deployment, marketplace publication: founder authorization required.
- **Coding-agent client acceptance** (Codex, Claude Chat, Devin, Antigravity, OpenCode, Hermes): per-surface receipts pending; blocked rows stay blocked.
- **Remaining wave tasks** (W2-05/07/11/12, W3-02/03/05/06/07/08): implemented states recorded above; each needs its regression before it can be marked locally verified.
- Platform-affiliate mutations remain disabled (separate initiative).

## Route/navigation map (current branch state)

- Primary (desktop): Home, Targets, Scans, Findings, **Reports** (new direct destination).
- Mobile bottom bar: Home, Targets, Scans, Findings + More sheet (Reports, Connections, Notifications, Fixes, Team, Settings, Billing*, Activity*, Evidence Vault*, Platform Admin* — *permission/conditional).
- `/dashboard/connections`: new consolidated destination (connected clients first, catalog second).
- Preserved URLs: `/dashboard/runs`→scans, `/dashboard/issues`→findings, `/dashboard/fixes` (alternate view), `/dashboard/agents` + `/dashboard/integrations` (install catalog), `/dashboard/approvals` (Activity), `findings?tab=reports`→`/dashboard/reports` (query scope forwarded).
