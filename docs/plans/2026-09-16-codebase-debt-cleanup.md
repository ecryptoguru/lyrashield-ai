# LyraShield AI — Codebase Debt Cleanup Plan

Date: September 16, 2026

Status: implementation dispatched across PRs #686–#688. This document supersedes the pasted “codebase debt & bloat removal — megaplan.” It records completed branch work and remaining merge gates; it does not authorize payout activation, merge, or deployment.

## Objective

Remove confirmed unused code and dependency declarations while preserving product behavior, compatibility, evidence, and test coverage. Prioritize dependency ownership and missing test execution before broad export pruning. Do not pursue a deletion count or add unrelated features.

## Review baseline and limits

- Reviewed checkout: `feat/myra-support-agent` at `ac78ca59a93cd13c67f123379d9b61d30c057d3a`.
- Fetched `origin/main`: `010d7b3a179f7ac983a4a809582229a958e5cafb`.
- Checkout was clean before review. It contained 2,689 tracked files; the feature branch differed from main across 128 files. These are snapshot facts, not permanent baselines.
- Review verified selected source consumers, package manifests, test configuration and focused tests. It did not repeat the original Knip audit or validate every proposed export deletion. The original 204 exports plus 32 types are unverified candidates, not an approved removal list.
- Verification completed: 70 tests across readiness, SARIF, and five affiliate job suites; seven newsletter endpoint tests; E2E typechecking; and `git diff --check`.
- The initial review discovered 16 desktop/mobile marketing cases across two root files. PR #686 migrated those cases into the marketing-owned browser suite and CI executed them. Merge, deployment, and production verification remain separate gates.

## Constraints

- Fetch configured GitHub remotes and record the actual base SHA before implementation. Recheck consumers on that base.
- Use a focused `codex/` branch and PR for each independently reviewable phase. Preserve concurrent work and user-owned files. Keep mainline cleanup separate from Myra branch changes; use an isolated worktree when needed.
- Freeze public CLI/MCP/SDK/plugin APIs, `action.yml`, API route paths and published package contracts. No schema or migration changes in this cleanup.
- Preserve billing, tenancy, approval, evidence, queue, and payout safeguards. Never enable dormant financial jobs as a cleanup side effect.
- Retain existing architecture. No package mergers, broad renaming, large-file splitting or new product subsystems.
- Read [the documentation retention rule](../README.md#retention-rule) before removing documents. Preserve outstanding decisions and operational evidence in their owning documents first.
- Do not equate missing imports with dead code. Check internal references, barrel exports, framework discovery, scripts, configuration, generated code, runtime loading, tests, and external compatibility.

## Phase 1 — Dependency ownership

### Proposed changes

| Location                             | Action after fresh verification                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/package.json`              | Remove unused declarations for `@azure/identity`, `@azure/keyvault-secrets`, `@modelcontextprotocol/sdk`, `@tanstack/react-query`, `bullmq`, `ioredis`, `clsx` and `tailwind-merge`. No source usage was found in web during review. Preserve dependencies in their actual owning packages. |
| `apps/web/package.json`              | Declare `server-only`, imported by `src/lib/billing-admission.ts`. Use a compatible version and the repository's existing package-management policies.                                                                                                                                      |
| `apps/desktop/frontend/package.json` | Remove unused JavaScript `@tauri-apps/plugin-store` after checking frontend consumers. Retain the Rust plugin and `@tauri-apps/cli`.                                                                                                                                                        |
| `packages/mcp/package.json`          | Recheck and remove unused dev dependency `@lyrashield/types`.                                                                                                                                                                                                                               |
| `packages/ui/package.json`           | Recheck `@types/react-dom` against type configuration and peer requirements before removal.                                                                                                                                                                                                 |
| `packages/egress-proxy/package.json` | Recheck `tsx` against scripts, CI, containers, and manual entry points before removal.                                                                                                                                                                                                      |
| `packages/myra/package.json`         | Handle on the Myra implementation base. Recheck `@lyrashield/config` and `@lyrashield/logger`; remove if unused rather than moving them automatically to dev dependencies. The cited `test-env.ts` imports only Node built-ins; config appears in comments.                                 |

Keep `pg`, `@prisma/client` and related DB typing/runtime declarations in this phase. Generated-client and adapter dependency ownership needs separate proof; a source grep alone is insufficient. Preserve runtime-provided `cloudflare:workers` imports.

Regenerate the lockfile with the pinned pnpm version without unrelated upgrades. Verify a clean frozen install, generated client, affected package builds/typechecks and actual runtime packaging where touched. Removing a declaration does not necessarily remove a transitive package or reduce bundle size; measure before claiming savings.

### E2E and evals decision

Keep the current non-workspace structure initially. `e2e/tsconfig.json` already declares explicit package mappings, `typecheck:e2e` is wired into CI and it passed review. The original claim of resolution solely through hoisting was incomplete.

The Myra eval entry is `evals/myra/run.ts`, with a documented command in `evals/myra/README.md` using the existing DB package's `tsx`. Prefer a small root script over another workspace package when a stable invocation is needed. Add workspace packages only if a demonstrated resolution or ownership problem warrants them; then inventory every import and verify Turbo task boundaries and clean-checkout execution.

## Phase 2 — Preserve and execute existing test coverage

### Marketing browser tests

Implemented in PR #686. The two root marketing specifications moved into `apps/marketing/tests-browser` and the redundant root `playwright.marketing.config.ts` was removed. The marketing Playwright configuration now runs the migrated cases on desktop and mobile viewports through the existing `test:browser` CI command.

The migrated suite retains the browser-only scanner no-network assertion, onboarding navigation, keyboard behavior, responsive layout and viewport coverage. Extensioned `/agents.md` and `/llms.txt` responses are exercised through direct route-handler tests because Wrangler's local asset normalization redirects those paths before Astro handles them.

### Conditional integration tests

CI already provisions `RLS_RUNTIME_DATABASE_URL` for restricted-role DB tests. Preserve that execution instead of adding a duplicate DB job.

Audit `TRIAL_INTEGRATION_TEST` separately: no workflow assignment was found during review. Inspect fixtures, setup, isolation, and teardown before enabling the billing trial and workspace integration suites against an isolated CI database. Never use production. Retain legitimate platform-specific skips, such as hardware keyboard assumptions on mobile WebKit.

Acceptance: document which suites run in which existing job and verify execution, not just test discovery or compilation. Any unresolved skip must have a reason and a concrete enabling condition.

## Phase 3 — Confirmed unused files

| Candidate                                             | Removal gate                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/responsive-list.tsx`         | Recheck every exported symbol, internal/path reference and dynamic consumer. Review found no consumers.                                                   |
| `apps/web/src/components/share-sheet.tsx`             | Same gate; review found no consumers.                                                                                                                     |
| `packages/affiliate/src/fraud/brandbid.ts`            | Remove the unreferenced placeholder after export/consumer checks. It returns a note without durable persistence; do not replace it with a new feature.    |
| `packages/licenses/src/fixtures/envelope.fixture.ts`  | Recheck fixture symbols and cross-language tooling; confirm TS/Rust golden-vector coverage remains intact before deleting this unused fixture.            |
| `apps/worker/src/jobs/affiliate-stuck-payouts.job.ts` | Remove after confirming no execution path or external contract depends on it and retain the recovery requirement below in the payout operations document. |

### Stuck-payout requirement

The legacy stuck-payout job is not equivalent to `packages/affiliate/src/payout/reconciliation.ts`. The latter reports drift; the former mutates payout and commission state. Without a provider-status callback, the legacy path can mark a payout failed and release reserved commissions after its timeout.

Never activate this fallback. Before future payout activation, recovery must distinguish confirmed failure from unknown or still-processing outcomes, retain reservations for ambiguous outcomes, bind provider identity and prove idempotent reconciliation. Deleting this file does not close that operational requirement or implement a replacement.

Retain the five tested affiliate jobs and their tests: token expiry, payout scheduling, reconciliation, commission release and reserve release. They remain dormant functionality awaiting activation review, not production-ready merely because their unit tests pass.

## Phase 4 — Internal export and type pruning

Produce a fresh candidate list using configured analysis plus consumer checks. Do not use the original 236-symbol count as a target.

- Start with a small app-only batch: terminology, license helpers, readiness, presentation, and parameter utilities.
- Distinguish removing `export` from deleting a declaration that remains locally used.
- `TARGET_ENVIRONMENT_LABELS` is used by `getEnvironmentLabel()`, which the target detail page calls. Retain it, remove only the export if safe or update its internal caller before removing the alias.
- `sarifToFindingRecords` is exported through the security package barrel. Inspect package contracts and every consumer before deciding whether to retain the alias; a barrel export alone does not establish a published API, but it is a consumer boundary.
- Preserve framework-discovered exports and intentional compatibility interfaces. Check package export maps, not only `index.ts`.
- Keep Myra `_lib.ts`, types, and exports in a separate batch based on its current implementation branch.

Acceptance: retain a concise per-symbol decision list in the PR, run relevant regressions and typechecks and verify changed package entry points. Stop when candidates become ambiguous or savings no longer justify risk.

## Phase 5 — Documentation and prevention

### Documentation retention

- Review `2026-09-12-release-legibility-coding-agent-handoff.md` requirement by requirement. Report provenance and release-reference checking exist, but the brief also contains deferred public identity confirmation and provider-aware availability requirements. Confirm implementation or record the retained decision before removal; do not infer completion from GateVerdict shipping.
- Verify the feature-differentiation and September 14 review documents against landed code and retained evidence before deleting them. Remove only material covered by the retention rule.
- Index `docs/myra-spec.md` in `docs/README.md` while Myra work remains active. Do not fold a live implementation specification into the user guide merely to reduce file count.
- Update only affected truth documents. Do not repeat the cleanup history across README, PRD, AGENTS, and codebase documents.

### Unused-code analysis

Add a reviewed Knip configuration and an initially informational report through existing CI if it provides useful signal. Verify the selected version and invocation during implementation rather than inheriting the pasted version claim.

Cover Astro and Next entry points, browser suites, eval runners, test-invoked scripts, marketplace artifacts, Prisma generation, package exports and intentional compatibility surfaces. Keep exceptions narrow and explain why they exist. No automatic deletions or broad ignore rules. Adopt a failing gate only after the baseline is reviewed and actionable; do not add a separate periodic workflow by default.

## Keep unchanged

- Newsletter/product-update forms, referral handling, scorecard notifications, `/api/waitlist` routes, rate limiting, tests, and D1 migration history. Public copy already presents subscriptions rather than a closed-registration waitlist. Internal renaming is optional and must preserve compatibility.
- Public logo assets until external usage is assessed; absence of source references or successful HTTP headers cannot establish absence of external users.
- Deprecated CLI alias through its compatibility window.
- `.github/scripts/parse-billing-receipt.mjs` and payment/payout evidence runbooks.
- DB schema and migration history, production admission settings, financial ledgers and evidence.

## Deferred work and feature policy

No new scanners, dashboards, automated payouts, package restructuring or large-file splits in this plan. File length alone is not sufficient justification for refactoring.

Prioritize finishing and verifying existing Myra, evidence, and payment workflows in their own workstreams. Provider-aware Local availability or public identity confirmation remains separate product scope where not implemented; this plan does not authorize either.

Local disk cleanup is a separate task. Do not recursively remove `lyrashield_runs`, `artifacts`, test reports, scratch directories or ignored files based on their names. Inspect contents and ownership first. Preserve user-owned recording/demo scripts and retained evidence. Cache cleanup offers local disk savings, not repository or runtime improvements.

## Verification and completion

For each implementation PR:

1. Record the base SHA, affected packages, concrete reason for each removal and preserved contracts.
2. Check symbols and paths across code, scripts, CI, framework configuration, package exports and generated/runtime consumers. Use Serena for substantive code navigation and targeted text searches for configuration.
3. Run focused regressions, affected lint/typechecks/builds and relevant packaging or browser tests. For dependency changes, verify clean frozen installation and lockfile scope. For fixture changes, verify both relevant TS and Rust coverage.
4. Before merge, run repository-required raw final checks: lint, typecheck, build, `pnpm test`, formatting, `git diff --check` and the repository checklist where applicable. Run migration consistency checks in an isolated environment when required by repository gates; do not mutate production or create cleanup migrations.
5. Report pre-existing failures and unavailable environments separately. Do not claim a full pass from a subset or a restored browser path from discovery alone.
6. Require fresh CI for the exact PR revision before any authorized merge. Deployment remains a separate gate: inspect existing automatic release triggers and report actual release behavior without treating this plan as authorization to deploy manually.

Completion means the dispatched cleanup phases pass their gates, retained requirements have an owner document and no public surface or test coverage was lost. Keep unresolved candidates explicit rather than deleting them to reach a numerical target. Once executed and absorbed, retire this plan under the documentation retention rule.
