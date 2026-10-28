# Test, CI and repository simplification plan

Review date: 2026-10-28. Implementation vehicle: [PR #1048](https://github.com/ecryptoguru/lyrashield-ai/pull/1048), branch `codex/reconcile-local-work-20261028`. Reviewed main: `f74deb53655ccb15cd0d0c3813ed4110bba68860`; reconciliation head: `9e9445e7369f01863b115e2af733305ecd0625a9`.

## Scope and decision

Reduce maintenance cost and elapsed CI time while preserving supported product behavior and meaningful regression coverage. Aim for fewer than 5,000 core cases only where removal is supported by equivalent coverage. Keep the work in PR #1048; do not create a separate cleanup PR. This document is the implementation plan, not a claim that the optimizations below have shipped.

The review covered test configuration and execution reports, expensive test bodies and their production callers, CI/release workflows and routing scripts, recent CI logs, dependency/dead-export analysis, tracked file sizes, documentation ownership, and the pending local/PR #1020 changes. It is not an exhaustive security audit of every product path. No evidence supports claiming that all technical debt can be removed in one change.

## Measured baseline

| Measurement                            | Observed result                                                                           | Interpretation                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Configured local core suite            | 7,744 passed; 102 skipped; 7,846 discovered; 751 files; 65.50 seconds                     | Includes the new Cancel regression. Disposable database suites were not enabled.                            |
| Earlier CI core suite, run 40659687373 | 7,867 passed; 91 skipped; 7,958 discovered; 781 files; 180.59 seconds                     | CI enables additional runtime fixtures; compare like-for-like configurations.                               |
| Marketplace export suite               | 35 cases; 57.83 seconds locally; 60.52 seconds in that CI run                             | Highest-value setup optimization; test count is a poor runtime proxy.                                       |
| Other expensive local suites           | WebMCP runtime checker 7.08s; launch-assurance 6.09s; API v1 parity 4.49s; CLI wait 3.07s | Inspect subprocesses, repeated imports, setup and real waits individually.                                  |
| Small core files                       | 220 files with at most three cases, totaling 464 cases                                    | Cohesive file consolidation can reduce imports and maintenance, but does not itself remove cases.           |
| Source/filesystem-reading candidates   | 97 core files, 886 cases                                                                  | Search candidates only. Many validate real files, packages, security or release contracts and must remain.  |
| Tracked repository content             | 46,129,107 bytes, approximately 44 MiB                                                    | No evidence of gigabytes of committed build/media bloat. Ignored developer outputs are a separate category. |
| Knip                                   | No unused files reported; 43 issue groups                                                 | Includes false positives and configuration gaps; not proof that every tracked file is needed.               |

Local timings are one observed run, not controlled medians. Concurrent development work and runner hardware affect comparisons. Reproduce using a frozen install, generated Prisma client, required SDK/MCP builds and the static CI auth environment. The initial unconfigured local run failed because prerequisites/environment were absent; it is not evidence of product regressions.

Baseline reports and reconciliation archives are retained outside the repository under `/Users/defiankit/.codex/recovery/lyrashield-local-20261028/`. Do not commit raw local logs or recovery archives. The CI evidence is available in [run 40659687373](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40659687373) and [successful run 40657061550](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40657061550).

### CI critical path

| Job or step                       |                      Run 40659687373 | Successful run 40657061550 |
| --------------------------------- | -----------------------------------: | -------------------------: |
| Lint, Typecheck, Test & Build job | 22m17s, failed late in browser tests |                     24m48s |
| Affected test suites              |                                 310s |                       378s |
| Marketing browser checks          |                                 250s |                       258s |
| Portable browser harness          |                                 176s |                       178s |
| Workspace typecheck               |                                 100s |                       101s |
| Workspace build                   |                                  82s |                        86s |
| Lint                              |                                  59s |                        61s |
| Metering/queue proof              |                                  50s |                        50s |
| Built-app browser checks          |                                  45s |                        48s |
| Container build job, parallel     |                                 757s |                       610s |
| Pinned engine contract            |                                  53s |                        45s |
| SCA/secret scan                   |                                  15s |                        12s |

In run 40659687373, the affected-test step contained approximately 181s core, 119s ops and 10s marketing unit tests. The browser failure concerned schedule-dialog focus and was addressed by main PR #1047; do not attribute that historical failure to PR #1048. Security and pinned-engine checks are comparatively cheap and should remain.

## Prioritized findings and fixes

### P1: Make deployment qualification independent of an assumed branch rule

**Evidence:** `.github/workflows/release-production.yml` runs on main pushes and assumes protected-main PR checks in a comment. Its routing script checks current main and previous successful deployment receipts, but does not qualify the incoming revision against required CI. During this review, the branch-protection endpoint returned `404 Branch not protected`, and `/rules/branches/main` returned an empty list. PR #1046 was merged before its CI run finished; that run subsequently failed.

**Fix:** establish actual required-check enforcement and add fail-closed release qualification. Preserve the three established required contexts: `SCA & Secret Scan`, `Lint, Typecheck, Test & Build`, and `Pinned Engine / Worker Contract`. Qualify the exact merged source through its associated PR, tested head/base and successful checks; handle the distinction between PR head, synthetic merge and squash/merge commit explicitly. Reject missing, pending, failed, cancelled, stale or ambiguous receipts. A current-main check alone is insufficient. Do not rerun the entire PR pipeline on every main push merely to compensate for missing qualification.

**Acceptance:** mocked GitHub responses exercise pending/failure/missing checks, stale base/head, pagination, squash/merge mapping, no associated PR, API failure and a valid exact-source receipt. Release routing cannot start either deployment without qualification. Inspect repository enforcement after applying settings; do not infer it from comments. Any operational settings change must preserve existing admission and deployment controls.

### P1: Reuse export fixtures without sharing mutable state

**Files:** `packages/agent-plugin/src/__tests__/export.test.ts`, `packages/agent-plugin/src/export.ts`.

**Evidence:** many validation/tamper cases call `exportMarketplace()` again. Every call reads Git state, copies plugin source, invokes `buildPlugin()` and builds a complete export. Those cases primarily test alterations to an already-built artifact. The suite consumes 57.83s locally and 60.52s in CI despite having only 35 cases.

**Fix:** create one immutable valid export for validation-only cases and copy it into a fresh temporary directory per mutating case. Keep each tamper case separately named. Retain fresh end-to-end exports for dirty-source rejection, concurrent generation, source freshness, deterministic output and publication/provenance behavior. Keep real shipped-validator execution where it proves the distributed artifact works; optimize common fixture generation first.

**Acceptance:** all 35 existing behaviors still execute; mutations cannot leak between cases; cleanup runs on failure; source-changing and concurrency tests remain isolated. Run the focused suite repeatedly and compare median wall time, then run core. Target at least a 50% reduction in this suite as an experiment, not a promised result. Revert the fixture approach if its provenance or isolation is weaker.

### P1: Route CI by actual consumers and preserve fail-closed selection

**Files:** `.github/scripts/classify-paths.sh`, its tests, `.github/workflows/ci.yml`, `turbo.json` and workspace manifests.

**Evidence:** all `apps/web` changes currently select the engine contract and database tests. Marketing test routing is already selective, but global `pnpm typecheck` and `pnpm build` still traverse unrelated workspaces. The root dependency and unknown-path fallbacks correctly select broadly. `.nvmrc`, `.python-version` and formatter configuration are classified as documentation despite affecting tooling; review their actual consumers before preserving that shortcut.

**Fix:** distinguish known presentation-only paths from server/worker/shared paths using an explicit, tested dependency map. Use workspace dependency/dependent closure for lint/typecheck/build. Keep unknown paths, dependency locks, shared schemas, environment/configuration, generated contracts and mixed changes conservative. Preserve intentional marketing dependencies on shared packages. Correct executable/toolchain classification before narrowing selection.

**Acceptance:** fixtures cover docs-only, UI-only, API/auth/billing/worker/database changes, marketing, desktop, shared packages, deleted/renamed files, mixed changes, missing outputs and unknown paths. A missing or corrupt routing result fails required checks. Compare old/new selected tasks for representative historical PR diffs; explain each removed task. No skipped required job may accidentally satisfy an aggregate after a failed dependency.

### P2: Remove repeated database-test startup only after identifying duplicate execution

**Files:** `.github/workflows/ci.yml`, `vitest.config.ts`, `run-all-tests.mjs`, `.github/scripts/assert-named-vitest-tests.mjs`.

**Evidence:** broad core execution is followed by separate metering, queue, trial, FK and RLS/runtime invocations. Each incurs Vitest/import/setup overhead. Some files may run in both broad and targeted phases, but different database roles and environment guards can make those runs distinct. Named-test guards protect against green runs where required fixtures silently skip.

**Fix:** map each required integration case to its environment, role, services and invocation. Remove only proven duplicate executions under equivalent conditions. Batch compatible files under one invocation per isolation group. Keep owner/runtime-role proofs, transaction isolation and fixture teardown intact. Split cheap units from disposable-service integration through explicit projects only if both remain required and their combined counts are reported.

**Acceptance:** before/after named execution reports demonstrate every required DB/Redis invariant still ran; no opt-in fixture silently skips; migration/FK/RLS, idempotency, money, account ownership and queue recovery checks remain. Use disposable services exclusively. Report total cases across projects so moving tests is not presented as removal.

### P2: Shorten the CI critical path without adding uncontrolled parallelism

**Evidence:** the main required job serializes unit/ops tests, marketing browser tests, portable browser tests and application builds. `run-all-tests.mjs` intentionally avoids simultaneous heavy suites on one runner. Container builds already run in parallel and are another substantial cost.

**Fix:** after routing improvements, evaluate separate independent jobs for marketing and ops alongside the app/core/database path. Keep a final fail-closed aggregate with the existing required name. Use bounded workers within each runner. Install dependencies and generate artifacts once per job; do not add a large matrix of tiny jobs whose setup costs exceed the work. Fail fast on inexpensive checks before expensive image qualification when dependencies permit.

**Acceptance:** compare at least three equivalent cold/warm runs where practical, including total billed runner minutes, queue time, critical-path time and failure diagnostics. Initial performance objective: at least 25% lower median elapsed time for comparable full changes and a materially smaller path for known UI-only changes. These are targets, not established savings. Keep unchanged security and engine checks; preserve cancellation and branch-concurrency behavior.

### P2: Reduce build duplication only where artifact contracts match

**Files:** `turbo.json`, `.github/workflows/ci.yml`, container Dockerfiles, `apps/marketing/scripts/preview-build.mjs`.

**Evidence:** workspace builds overlap package work later performed in container builds. Prisma generation is uncached in Turbo and also invoked explicitly by CI. Marketing local-preview and production builds have different environment behavior; the preview script already reuses a correctly marked preview artifact.

**Fix:** measure duplicate generation/build tasks, define correct inputs/outputs and cache only deterministic artifacts. Select individual web/worker/egress container builds by their source/dependency changes. Reuse artifacts only with matching source, platform, build inputs and environment. Do not reuse a local-preview artifact for production or remove container qualification merely because a host build passed.

**Acceptance:** clean-checkout builds, cache-hit and changed-schema/config cache-miss cases, generated-client availability, built-app browser tests and relevant image contracts pass. No secrets or developer `.env` files enter cached/public artifacts. Record build count and duration before/after.

### P2: Replace duplicate test ownership with one authoritative behavior check

**First concrete candidate:** `apps/web/src/__tests__/api-v1-parity.test.ts` contains one exhaustive source-discovery contract and 26 manually enumerated dynamic-import parity cases; the file costs 4.49s locally. Retain exhaustive route/method coverage, the intentional v1 DELETE omission and a minimal runtime smoke. Prove the discovery checker catches wrong source paths and wrong/missing methods before removing overlapping manual cases. Preserve real route authorization and payload tests in their owning suites.

**Broader audit:** inspect the 97 source/filesystem-reading files and the 220 tiny test files for overlapping ownership. UI tests that merely require a source substring are candidates when a rendered interaction already proves the behavior. File/package integrity, published artifact, isolation, workflow and security tests are not redundant simply because they read source or files. Keep `request-schema-spec-parity` behavior coverage; it compares route and OpenAPI validation rather than merely asserting text.

**Acceptance:** each deletion records the old case, covered invariant, surviving test and reason the overlap is equivalent. Consolidate fixtures and coherent files while preserving independently meaningful case names. Use targeted negative mutations where appropriate to prove that the surviving tests detect the regression. No loops hiding thousands of cases under one `it`, inflated skips, renamed suites or weakened assertions to satisfy the count target.

### P2: Correct the dead-code audit, then remove proven unused declarations

**Files:** `knip.json`, workspace manifests and the specific flagged declarations.

**Evidence:** Knip reports unused exports/dependencies alongside generated-client and test-resolution false positives. `localZoneName` in `apps/web/src/lib/date-format.ts` is used internally: only its export may be unnecessary. The formatter re-export in `apps/web/src/lib/target-domain-status.ts` has consumers importing its owning module directly. Generated Prisma runtime code references `@prisma/client-runtime-utils`; deleting that dependency based only on Knip would be unsafe.

**Fix:** distinguish public package API from internal exports, model generated entry points and deliberate browser-test resolution, and inspect dynamic/import-string consumers. Remove redundant internal exports without deleting internally used functions. Verify the two font dependencies in `apps/marketing-motion/package.json` are unused there before removing those declarations; retain the marketing app's independent font dependencies. Investigate desktop styling before accepting the Tailwind warning.

**Acceptance:** package builds/typechecks and relevant consumer tests pass; package export/packed-artifact contracts remain intact; lockfile changes are generated by pnpm. Do not add dependencies solely to silence a resolver false positive. Establish a reviewed baseline and prevent new unexplained findings rather than making existing noisy output abruptly blocking.

### P3: Remove superseded assets/documents and keep recovery outside source

**Evidence:** legacy `console-*.webp` product images have no discovered application consumers; the product asset README describes historical usage. Current images and their provenance are separate. The repository already ignores major build outputs. Documentation has explicit ownership/retention rules in `docs/README.md`, and some older consolidation work has already happened.

**Fix:** verify indirect/public URL use before deleting legacy images; update their README without retaining duplicate copies. Review completed `.impeccable` design plans and dated handoffs against current PRD/codebase owners. Delete only superseded, unreferenced material without operational, legal, security, publication or evidence value. Retain migrations, reproducible operational probes, marketplace source/licensing and current customer documentation. Keep ignored build/cache cleanup a separate local action; never recursively delete user environments or recovery worktrees as “bloat.”

**Acceptance:** reference searches, asset/build checks and documentation links pass; each removed file has a recorded rationale and Git recovery path. Measure tracked bytes/files and package/install impact separately. Avoid a new permanent archive directory that merely relocates redundant files.

## Test-count decision and coverage floor

The current local passing count is 7,744, rather than the earlier 7,741. Reaching 4,999 requires removing at least 2,745 currently passing cases. The initial candidate inventory does not demonstrate that much redundancy: even all 886 source/filesystem-reading cases would be insufficient, and many are necessary. The fastest large suites are often important: worker run-scan has 122 cases in approximately 158ms; request-schema parity has 68 in 38ms; result-integrity has 64 in 77ms. Removing those solely for count would make the product less reliable with little runtime benefit.

Maintain a review ledger during implementation with columns: old test/case, invariant, surviving coverage, deleted/reworked/retained disposition, count delta and validation. Include newly added regression cases in net totals. Do not introduce a brittle 5,000-case CI ceiling that pressures future contributors to remove useful regressions. Report passing, skipped and discovered counts, files, test setup time and total runtime for each configuration.

Coverage floors are behavioral: account/workspace isolation; sponsor and entitlement ownership; Decimal/idempotent billing; permission and credential boundaries; untrusted engine/queue input; manifest/retest integrity; egress/SSRF controls; release provenance; recovery/cancellation; and accessible keyboard/mobile user flows. Keep full distinct boundary cases in these areas. Use baseline line/branch coverage as supplementary evidence, not a substitute for these invariants. Current coverage reporting has no enforced threshold; obtain a reproducible baseline before claiming coverage did not decrease.

## Execution order inside PR #1048

| Wave                         | Work                                                                                                           | Exit criterion                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 0 — completed reconciliation | Preserve local snapshot; retain useful missing Cancel behavior; refresh API route count; include current main  | Original checkout clean, recovery verified; focused regression and browser proof pass                                 |
| 1 — baseline and safety      | Capture comparable timing/count/coverage baseline; repair release qualification and unsafe routing assumptions | Negative routing/release tests and exact-source qualification pass                                                    |
| 2 — highest runtime return   | Export fixture reuse; API parity overlap; equivalent DB invocation consolidation                               | Same distinct invariants, measured faster focused/core/integration runs                                               |
| 3 — CI simplification        | Consumer-based task selection, bounded independent jobs, deterministic generation/cache and image selection    | Representative change matrix passes; required aggregate fails correctly; comparable CI time/cost improves             |
| 4 — justified removals       | Case-by-case duplicate tests, dead exports/dependencies, obsolete assets and completed documents               | Deletion ledger, consumer checks and count/size deltas reviewed                                                       |
| 5 — final qualification      | Rebase/merge current main normally; review combined diff and affected truth documents                          | Required CI successful on final head, no unresolved review regressions, deployment consequences reviewed before merge |

Each wave is a focused commit in the existing PR, with the PR description rewritten to reflect what is actually implemented. Do not merge the partial reconciliation while the agreed cleanup work is still pending. Keep PR #1020 as a recovery reference until its supersession is resolved; do not bulk-merge its conflicted older snapshot over newer main.

## Verification and remaining limits

Completed for the reconciliation implementation: focused regression demonstrated failure before the fix; five render tests passed; two Chromium Cancel/navigation checks at 390px and 1440px passed; workspace typecheck completed 36 tasks; web-test and browser-harness typechecks, targeted ESLint/format checks and `git diff --check` passed. The configured local core run passed 7,744 cases with 102 skipped. These results do not establish that the proposed cleanup has been implemented or verified.

For each wave run its focused checks first, then the affected project checks. For the final combined change run configured core, marketing/motion/ops when affected, disposable PostgreSQL/Redis required suites, lint/typechecks, formatting, builds, affected rendered browser flows and image/release contracts. Preserve raw authoritative outputs for final evidence. Record unavailable services and unexecuted acceptance explicitly. No live paid scan, customer charge, production mutation or signed Desktop release is part of this review.

At plan publication, the optimizations remain planned. The below-5,000 target, full coverage comparison and CI performance improvement remain unproven. Final acceptance depends on measured runtime improvement and retained behaviors; if the justified deletion ledger cannot reach 4,999, report the safe resulting count and remaining independent coverage rather than manipulating the metric.
