# Coding-agent handoff: simplify LyraShield across all three waves

Date: 2026-09-09. Status: implementation handoff, not a completion or deployment receipt.

## 1. Objective and authorized decisions

Implement all tasks below, including the three simplification waves and the shared automation foundations needed to make them reliable. Deliver a coherent first-session, dashboard, scan, remediation, connections, and settings experience. Preserve the existing architecture; do not replace the application with a new design system or chat-only UI.

The intended everyday journey is: sign in, select an authorized target, start the recommended check, act on the result, and share the evidence when useful.

Founder-selected permission policy is **Option 3**:

- Every active workspace member has operational read/write access, including members whose stored roles are Viewer, Auditor, External Pentester, or Billing Admin.
- Operational access covers projects, targets, scans, findings and dispositions, fixes and fix PRs, retests, reports, schedules, notifications, and AI-assurance workflows.
- Ownership, membership administration, billing, policies/budgets, integration credentials, platform administration, and management of another user's connections retain their existing administrative restrictions.
- An authorized operation must not require a redundant LyraShield review step. OAuth consent or credential setup establishes the connection's authorization; subsequent execution revalidates it automatically.
- Existing read-only or limited credentials are not silently expanded. When a broader grant is necessary, use one clear reconnect path rather than a per-action approval queue.
- Host-controlled coding-agent permission dialogs cannot be suppressed by LyraShield. Do not claim otherwise.
- Source ownership/target authorization, credential scopes, current membership, expiry/revocation, plan/budget checks, idempotency and audit remain mandatory. These are automatic checks, not extra user dialogs.
- Never auto-merge a fix PR. Accepted risk and false-positive decisions are dispositions, not technical verification.

This decision supersedes older product prose saying Viewer/Auditor roles are operationally read-only. Preserve persisted role enums and administrative distinctions. Reconcile affected truth documents as changes merge.

## 2. Starting state: verify before working

Observed when this handoff was prepared:

- Product checkout: `/Users/defiankit/Desktop/lyrashield-ai`.
- Branch: `codex/automatic-connection-authorization`.
- Local/source PR head: `42151e08108fca93719fbf759a972171bf453877`.
- [PR #637](https://github.com/ecryptoguru/lyrashield-ai/pull/637) was OPEN and no longer marked draft. This does not establish passing CI, merge, publication, or deployment.
- Before creating this document, the checkout was clean. This document and its index entry are intentional handoff files; preserve them.
- Prior local receipts for that implementation: 3,429 core tests passed, 46 tests skipped in that invocation; a separate isolated database/RLS run passed all 34 tests; 15 targeted lint/typecheck tasks passed; production-build Playwright acceptance passed.
- The browser test exercised consent at mobile/desktop widths, Viewer/Auditor report creation, denied API-key administration, and denied writes after inactive membership. It did not prove every client, provider, workflow, or release.

First actions:

1. Fetch remotes, inventory worktrees and tracked/untracked/ignored changes, and inspect current PR #637 status, head, checks and review comments. Do not overwrite another agent's work.
2. Read `AGENTS.md`, `PRD.md`, `codebase.md`, `userguide.md`, the current schema/migrations and applicable nested instructions. Executable evidence wins over stale status prose.
3. Read `docs/audits/2026-09-09-automatic-connection-review.md` and the earlier seamless-integration handoff for unresolved execution contracts. Do not reimplement work already merged.
4. Establish whether #637 is merged, superseded, or still needs repair. Base dependent work on the actual accepted implementation; never assume its SHA is main or deployed.
5. Create focused `codex/` branches/worktrees. Never push directly to main, force-push over others, or bypass CI. Prefer one coherent product integration PR for this initiative; use dependency PRs only where schema/package/release sequencing requires them and link them explicitly.
6. Create an execution ledger using section 10. Record current source, regressions, acceptance and blockers independently.

Do not recreate billing staging or Azure resources. Retain existing billing receipts. No real payment, billable scan, paid model evaluation, public publication, recruitment, or pricing change is authorized by this implementation handoff. Complete local and nonbillable tests first; for any required paid acceptance, prepare the exact target/profile/budget and obtain the missing authorization.

## 3. Chosen product direction

### Navigation and terminology

Desktop primary destinations: **Home, Targets, Scans, Findings, Reports**. Secondary destinations: **Connections** and **Settings**. Put notifications in the shell's existing notification entry; administrative destinations remain permission-gated. Preserve a compact mobile bar and make every other destination reachable from its More sheet.

Use Targets, Scans, Findings and Reports consistently in user-facing copy. Explain a target as a repository, website or API. Replace visible “Trust Runs” with “Scans.” Product/project grouping can remain optional metadata. Do not rename database models, enums, API keys, package names, CLI commands or public contracts merely to match labels.

A target detail page is the stable place to see that target's current assessment, scans, findings, remediation and reports. A workspace overview must not imply one all-clear result across unrelated targets or revisions.

### Home

One dominant next action, chosen from the same decision model everywhere it appears. Show the selected target's current gate state, source/assessment scope and freshness before scores. Initial summary: actionable blockers, assessment freshness/coverage and current activity. Detailed charts and technical receipts remain available on demand.

### Setup

Create or reuse a sensible workspace when required; invited users enter their authorized workspace. Select repository or URL/API, prefill a name, recommend an eligible review, show scope and expected usage, and start it. Keep optional classification out of the critical path. Never infer source authorization from a URL or name.

### Automation

Default to executing authorized operational requests without a review queue. Show durable operation status and recovery. Automation must not mean silent recurring charges or replaying ambiguous paid work. Recurring schedules need an established trigger and budget; do not enable them merely because a user logged in.

## 4. Wave 1 — remove immediate friction

| ID    | Task and implementation contract                                                                                                                                                                                                                                       | Acceptance                                                                                                                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1-01 | Standardize visible terminology through the existing terminology module and consumers. Replace “Trust Run” with “Scan”; use Findings consistently instead of mixing Issues/Finding labels. Keep technical identifiers and compatibility URLs.                          | Navigation, onboarding, dashboards, notifications, connection guides and empty states use the chosen nouns. Existing deep links still resolve.                                                                            |
| W1-02 | Use one canonical home decision for the header CTA and next-action panel. Avoid competing prominent actions. During an active scan, lead with its progress rather than recommending a duplicate scan.                                                                  | Fixtures for no target, no assessment, active scan, failed assessment, blocker, stale assessment and complete assessment produce one coherent action on desktop/mobile.                                                   |
| W1-03 | Make home recommendations consume the current canonical gate/applicability result. `deriveHomeNextAction` currently uses issue counts and report existence without current gate state. Remove the inference that zero recorded blockers establishes release readiness. | Missing coverage, expired assessment, revision mismatch, unresolved uncertainty and newer failed attempts cannot produce a ready-oriented recommendation. Historical reports remain available.                            |
| W1-04 | Prioritize target-specific readiness over security score. Show date, freshness, coverage limitations and the selected target. Move score/grade, trends, severity charts and detailed verification counts into secondary context.                                       | A clean score never overrides insufficient evidence or a blocking gate. Mixed workspace targets remain separately scoped.                                                                                                 |
| W1-05 | Reduce initial dashboard metrics to blockers, freshness/coverage and activity; keep details accessible. Preserve meaningful empty/loading/error states.                                                                                                                | No duplicate score/status cards above the fold; useful state at 390px and desktop without horizontal overflow. All removed summaries remain reachable where needed.                                                       |
| W1-06 | Replace silent workspace-switch failure in `v2-sidebar.tsx` and equivalent shell paths with a visible, accessible retry message. Retain the last confirmed workspace. Preserve the full navigation reset until tenant-state isolation is proven for any alternative.   | Failed persistence changes neither selected workspace nor displayed tenant data. Retry succeeds; rapid switches cannot expose mixed-workspace content.                                                                    |
| W1-07 | Present failures as cause, effect and recovery action. Reuse structured server reason codes; do not parse strings or expose internal errors/secrets.                                                                                                                   | Connection expiry, no repositories, target authorization failure, exhausted budget, unavailable service and incomplete evidence each have an accurate next action. No error creates an automatic approval or paid replay. |
| W1-08 | Make Option 3 understandable in Team and permissions displays: every active member has operational access; roles distinguish administrative capabilities. Viewer/Auditor labels must not suggest read-only operational access.                                         | UI and API permission projections agree for every persisted role. Removed members fail closed; billing, API-key administration, ownership and other-user connection management stay restricted.                           |
| W1-09 | Replace ordinary approval-queue navigation with operation activity/recovery. Keep historical approvals and audit records accessible in a history destination, preserving URLs. A legacy insufficient grant should offer reconnect, not repeated review prompts.        | New connected workflows do not create pending review requests. Legacy data remains readable by authorized users. Host dialogs are described separately.                                                                   |
| W1-10 | Consolidate inline status presentation: queued/running/completed/failed and reconnect/retry links at the action origin. Use existing progress, alert and receipt components.                                                                                           | Background updates are announced appropriately without stealing focus; successful operations link to their durable result; refresh/back preserves useful context.                                                         |

Primary files to inspect: `apps/web/src/lib/terminology.ts`, `nav-items.ts`, `home-next-action.ts`, `dashboard-overview.ts`, `launch-readiness.ts`, `launch-readiness-server.ts`, `scan-presentation.ts`; `apps/web/src/components/v2-sidebar.tsx`, `trust-command-center.tsx`; `apps/web/src/app/(dashboard)/dashboard/page.tsx`, `team/team-client.tsx`, `approvals/*`.

## 5. Wave 2 — shorten the main journey

| ID    | Task and implementation contract                                                                                                                                                                                                                                                                      | Acceptance                                                                                                                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2-01 | Remove mandatory workspace naming from first-run setup. Reuse an authorized active/invited workspace; create a default only when none is suitable. Keep renaming available later. Reuse onboarding persistence and workspace creation services.                                                       | Refresh, concurrent tabs and retries cannot create duplicate workspaces or trials. Invitations and users with multiple workspaces remain unambiguous.                                                                                              |
| W2-02 | Combine target selection and naming. Prefill from authorized repository metadata or a parsed host. Keep editable names; deduplicate against existing targets using existing identity rules.                                                                                                           | GitHub, URL and API paths preserve input across back/refresh. Same-source retry does not create a second target. Invalid/unauthorized sources remain blocked.                                                                                      |
| W2-03 | Defer optional environment/product grouping to target settings. Any field that changes scanner eligibility, authorization or execution stays explicit when required.                                                                                                                                  | Defaults do not silently identify a production target as staging or expand scan coverage. Optional grouping is editable after setup.                                                                                                               |
| W2-04 | Recommend one eligible first review using existing presets and eligibility checks. Offer other supported reviews through “Change review”; preserve essential scope, limitations and usage disclosure outside collapsed details.                                                                       | Recommendation agrees with authoritative POST validation. Unsupported target/profile combinations never appear runnable. No hidden upgrade or billable action.                                                                                     |
| W2-05 | Support agent-first onboarding. A user arriving from an OAuth connection completes only the identity/workspace/source requirements needed for that flow, then returns to the originating client.                                                                                                      | Signed return-state validation, cancellation, expiry and membership checks pass. No open redirect, forced unrelated dashboard tour or manual workspace-ID copying.                                                                                 |
| W2-06 | Resume unfinished setup after authorization, refresh or reopening. Extend the existing onboarding state rather than adding a second wizard/session store.                                                                                                                                             | Cancelled/slow authorization, zero repositories, revoked installations, stale responses and multiple tabs recover accurately. Explicitly skipped setup does not unexpectedly restart.                                                              |
| W2-07 | Carry context across target, scan, finding and report actions. Automatically select the only target. Remember last successful eligible per-target review choices, rechecking them before execution.                                                                                                   | Context is target/workspace-bound and invalidated on switch/deletion/permission loss. Old defaults cannot choose an unsupported or more expensive profile silently. Multi-target users retain explicit selection.                                  |
| W2-08 | Consolidate Coding Agents and Integrations into Connections, with coding agents, source control and other services grouped inside. Start with connected clients; show the install catalog second.                                                                                                     | Existing install paths, OAuth callbacks, registry support distinctions and URLs remain valid. No browser claim of local agent detection without a trusted local source.                                                                            |
| W2-09 | Provide connection health and recovery: identity, workspace, capabilities, status, last successful operation, reconnect and disconnect. Distinguish installed, authenticated, usable for reads and usable for writes.                                                                                 | Expiry, revocation, scope limitation and unavailable host support render accurately. Never expose tokens or label a tools/list result full acceptance. Members manage their own permitted connections; other-user administration stays restricted. |
| W2-10 | Make Reports a direct destination and target tab. Consolidate fixes under Findings with Open, Fixes in progress and Resolved views using canonical state projections. Retain compatibility redirects; keep a cross-target fix view only as a useful alternate view, not another independent workflow. | All navigation works on mobile and desktop. Old report/fix links retain query scope. Detection, remediation, disposition and verification are not collapsed into one misleading state.                                                             |
| W2-11 | Split Personal settings from Workspace settings using existing components/routes. Personal: profile, login methods, security. Workspace: members, connections, billing, retention and policies. Keep administrative actions permission-gated.                                                         | Users cannot change another account or workspace through preserved form state. Account deletion stays distinct from workspace deletion. No credential administration is granted by rearranging UI.                                                 |
| W2-12 | Preserve findings-table filters, target, cursor context and scroll when opening/closing details. Make the scope of search/sort explicit; use server sorting if claiming whole-result sorting.                                                                                                         | Back navigation restores context; mobile details have usable focus restoration. No client-only sort claims global ordering or bypasses stable pagination.                                                                                          |

Primary files: `apps/web/src/app/onboarding/{page.tsx,onboarding-wizard.tsx,onboarding-flow.utils.ts}`; `apps/web/src/app/api/onboarding/route.ts`; GitHub install/callback/repository routes; `apps/web/src/lib/{onboarding-state.ts,scan-presets.ts,nav-items.ts}`; dashboard `targets/*`, `scans/*`, `findings/*`, `reports/*`, `fixes/*`, `agents/*`, `integrations/*`, `settings/page.tsx`; `apps/web/src/components/{workspace-switcher.tsx,api-keys-section.tsx}` if present. Verify actual component locations before editing.

## 6. Wave 3 — automate follow-through

Wave 3 depends on reliable operation identity, authorization and retry handling. Complete W3-01 before introducing new automated durable side effects.

| ID    | Task and implementation contract                                                                                                                                                                                                                                                                                                                                                                                  | Acceptance                                                                                                                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W3-01 | Establish shared durable operation semantics across CLI, REST, hosted MCP, local stdio and new WebMCP execution paths. Reuse `AgentOperation` and existing services where suitable. Inspect its connection FK and lifecycle before extending it; never fabricate an OAuth connection for an API key or browser session. Add the minimum versioned/additive storage needed for principal-bound operation identity. | Identical retries yield the same operation/result; same key with changed input conflicts; concurrent duplicates execute once; ambiguous failures are not replayed. Recheck current membership, scope and target before results/replay. No cross-principal/workspace collision or disclosure. |
| W3-02 | Give each finding one next action based on canonical workflow, evidence, applicability and disposition. Example actions: inspect evidence, generate fix, open PR, or retest. Keep alternatives in a secondary menu.                                                                                                                                                                                               | Every state has an accurate action or reason none is possible. Missing source/patch/grant/coverage does not offer an executable action. An already-running operation returns status rather than starting another.                                                                            |
| W3-03 | Build one remediation timeline from stored receipts: proposed, PR opened, applied, retested, verified. Show accepted risk/false positive separately. Do not infer “applied” from PR creation or “verified” from engine absence.                                                                                                                                                                                   | Matching source/PR/retest lineage is required. Out-of-order events, closed-unmerged PRs, reopened findings and failed retests remain truthful. Display pagination never truncates decision evidence.                                                                                         |
| W3-04 | Trigger a fresh retest after a trusted merge/application event when the existing connection/workflow and budget authorize it. Reuse signed GitHub webhook validation, fix-PR producer/retest loop closure and shared queue authority. Inspect deployed behavior first; extend missing pieces rather than enqueueing a second retest system.                                                                       | Duplicate/reordered deliveries, unrelated merges, changed permissions, exhausted budget, missing base/source identity and interrupted jobs cannot create duplicate paid work or false resolution. Never auto-merge.                                                                          |
| W3-05 | Prepare a private immutable report snapshot after a qualifying completed assessment. Bind it to exact scan/manifest/gate inputs and report schema. Reuse report constructors and signing policy. Sharing/publication remains explicit.                                                                                                                                                                            | One snapshot per defined assessment/type/version policy despite duplicate completion events. Retrying report creation never replays a scan. Failed/incomplete scans do not acquire readiness claims. Expired reports remain historical and cannot show a current-ready badge.                |
| W3-06 | Group routine notifications while prioritizing blocked automation, connection failures, important findings and meaningful assessment changes. Use existing notification preferences, dedupe keys and delivery providers.                                                                                                                                                                                          | No duplicate notification storm on webhook/worker retries. Preferences and tenant privacy hold. Critical actionable failures remain visible even when routine completions are grouped. Do not send acceptance emails to real users without authorization.                                    |
| W3-07 | Add explicit WebMCP durable tools for authorized operational actions as needed, starting with scan execution. Keep `prepare_security_scan` nondurable and backward compatible; do not silently change what it does. Use server-bound workspace/principal identity, same-origin protections and W3-01 operation semantics. Extend receipt types to truthfully distinguish preparation from persisted actions.      | Read-only/preparation tools do not mutate. Execution checks live membership, scope, target and budget. Agent input cannot supply another workspace/principal. Cancellation after server acceptance reports an existing/uncertain operation rather than falsely claiming no side effect.      |
| W3-08 | Use one operation-status/recovery contract across dashboard, CLI, MCP and WebMCP. Include stable operation ID, status, safe reason code, result location and permissible recovery. Respect polling backoff/cancellation; reuse existing transports.                                                                                                                                                               | Text/JSON/UI agree. Reconnect retries preserve operation identity. An authentication failure never falls back to another identity or cached approval. Restart/upgrade does not replay an already completed mutation.                                                                         |

Primary files: `packages/db/src/{agent-operation-service.ts,agent-connection-service.ts,agent-approval-service.ts,fix-proposal-service.ts,retest-service.ts,report-service.ts,launch-report-service.ts}`; `packages/auth/src/{session.ts,oauth.ts,permissions.ts}`; `packages/credentials/src`; `packages/mcp/src`; `packages/cli/src`; `apps/web/src/app/api/mcp`, `webhooks/github/route.ts`, finding/fix/retest/report routes and `/api/v1` wrappers; `apps/web/src/lib/{fix-pr.ts,fix-pr-context.ts,webmcp/*}`; `packages/integrations/src/{queue.ts,notifications.ts}`; relevant worker terminal/retest handlers. Use `rg` to trace producers, consumers and exported SDK types before changing any shared contract.

## 7. Cross-cutting requirements

### Authorization and evidence

- Use the shared operational permission set; do not replace `requirePermission` with unconditional success or weaken active-membership checks.
- Keep RLS, workspace IDs, Zod validation, audit-chain rules and public allowlists intact.
- Creating an automatic authorization receipt must not fabricate a human approver. Preserve credential/session provenance, exact inputs and audit-before-execution behavior.
- Keep current gate/applicability uncached for release decisions. Scores, charts, finding counts and reports cannot independently decide READY.
- Complete, matching deterministic retest receipts govern technical remediation. Human dispositions remain explicit and auditable.
- Keep source material available to authorized scanners while sanitizing model-facing and exported data through existing shared pipelines.

### UX and accessibility

- Reuse the current UI components, spacing, forms, status presentations and navigation helpers. No new UI framework, animation system, global mode switch or onboarding store.
- Preserve keyboard navigation, focus restoration, accessible names, live-region feedback, reduced motion, mobile navigation reachability and long-content handling.
- Essential scope, eligibility and usage information must not be hidden behind an “Advanced” toggle. Detailed explanations can be collapsed.
- Preserve valid form values on recoverable failures. Differentiate empty data, loading, filtered-empty and failed loading.
- Use useful status updates without repeatedly interrupting users. Reference: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html.

### Performance and analytics

- Record a before/after baseline for touched flows: request count, payload size, database duration, cache behavior, page/interaction timing and representative p95 where sample size permits. Do not invent performance gains from bundle size or a single run.
- Preserve tenant-specific invalidation, membership checks outside cached data, cursor pagination and bounded history. Avoid loading the entire workspace for a simpler-looking screen.
- Reuse server-owned assessment records for first valid assessment and repeat-assessment metrics. Client analytics may describe interactions but cannot prove completed assessment quality.
- Instrument setup abandonment, time to first valid assessment, connection success, repeated input, recovery success and repeat assessment. Define denominators/time windows and record insufficient samples honestly.
- Keep analytics allowlisted: no credentials, repository URLs, source, findings text, evidence payloads, exact private revisions or raw OAuth errors. Do not send model costs into public/dashboard analytics.

### Compatibility

- Preserve old URLs/query context through redirects, aliases or adapters. Several legacy routes already redirect; do not build new duplicate pages for them.
- Coordinate API, SDK, CLI, MCP, plugin and WebMCP schema changes. Version breaking envelopes/tool contracts; retain historical signatures and original signed bytes.
- Keep new read/write setup simple, but never silently elevate a previously read-only token. Resolve unsupported client capability as unsupported, not an invented success.
- Update the product generator before exporting marketplace artifacts. Keep release pins and declared versions synchronized. Publish only after source is accepted and referenced packages exist.

## 8. Test and acceptance matrix

Add a regression for each changed behavior before fixing it. Use existing Vitest, Playwright, database runtime, packaging and CI tooling. Do not add a framework or tests that merely repeat implementation details.

| Dimension    | Required cases                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Membership   | Every persisted role can perform defined operational actions; active/inactive/removed members; no membership; foreign workspace; administrative restrictions unchanged.                                          |
| Credentials  | Browser session, read-only/write API key, new delegated OAuth, legacy/limited OAuth, expiry, refresh, revocation, changed scope/version, wrong audience/issuer, concurrent refresh/logout.                       |
| Setup        | New/invited/returning users; zero/one/multiple workspaces and targets; GitHub/URL/API; cancel/slow authorization; no repos; revoked install; refresh/back/multiple tabs; unavailable trial/budget.               |
| Gate/UI      | READY, NOT_READY, INSUFFICIENT_EVIDENCE; missing coverage; unsupported target; missing/mismatched revision; exact expiry boundary; newer failed/incomplete attempt; no findings; known blocker plus uncertainty. |
| Operations   | Identical/different input retry, concurrent calls, process crash before/after acceptance, slow network, lost response, restart, upgrade, late cancellation, permission loss before replay.                       |
| Remediation  | Proposal-only, opened PR, closed-unmerged PR, trusted merge, wrong branch/revision, completed/failed/inconclusive retest, accepted risk, false positive, reopened finding.                                       |
| Reports      | Duplicate terminal events, private default, explicit sharing, public allowlist, signing/tamper/revocation, expired/superseded current status, no source identity leak.                                           |
| Presentation | Mobile 390px and narrow fallback, tablet, desktop; keyboard-only, screen-reader labels/status, focus return, reduced motion; long names/tables/errors; all navigation reachable.                                 |
| Regression   | Billing admission unchanged; no duplicate trial/usage debit; queue/retest lineage intact; tenant cache/history behavior preserved; old routes and supported SDK clients remain usable.                           |

Run relevant lint, typecheck, formatting, builds, tests and `git diff --check`. Run database runtime tests against an isolated migrated database with actual nonsuperuser/non-BYPASSRLS roles. Skips are not acceptance for required database cases. Never print production secrets or raw credential fixtures in failure logs.

For browser changes, inspect rendered pages, not only static markup. Record screenshots/receipts in ignored artifact locations; do not commit generated media/build output. Use an isolated test profile and nonbillable data.

For touched coding-agent contracts, test the exact release on Codex, Claude Chat (the founder's available Free-account substitute), Devin's actual supported interface, Antigravity, OpenCode and Hermes where installed/available. Check current official vendor docs before choosing each integration path. Record installed client/version, transport, package/source version, reads, authorized nonbillable writes, replay/conflict, refresh, revocation, permission loss, restart and upgrade independently. Claude Chat is not Claude Code acceptance; terminal-only proof is not desktop-host proof. Extend acceptance to other affected advertised clients, including Gemini if its published read-only policy changes. Do not claim all-client completion with unsupported or blocked rows.

## 9. Rollout and rollback

1. Resolve the actual #637 baseline and failing checks/reviews, if any.
2. Implement and validate Wave 1. Keep the permission policy and home decision fixtures canonical.
3. Implement Wave 2 on that foundation; verify full setup-to-first-result and returning-user flows.
4. For Wave 3, land additive operation storage first if necessary; verify old/new application compatibility. Then deploy consumers and automatic triggers in dependency order.
5. Run final consolidated regression, security/authorization review and exact-PR-head CI. Use a small, explicit internal rollout control only if needed for new side effects; do not create user-facing complexity to manage release safety.
6. Merge only through normal reviewed PR/green-check policy. Use existing deployment workflows, immutable revisions/digests and smoke checks. No direct main push or ad hoc production mutation scripts.
7. Verify merged-main CI separately from PR-head CI. Record actual app/worker/package revisions and traffic. Run exact-release browser and affected-client acceptance.
8. Rollback UI/consumer behavior without reverting additive schema. Stop new automatic triggers if safety is uncertain; retain operation receipts and in-flight work. Never regain apparent success by bypassing applicability, authorization or replay checks.
9. Update `AGENTS.md`, `PRD.md`, `codebase.md`, `userguide.md`, relevant CLI/MCP guides and generated integration docs to the actual merged/released behavior. Historical receipts remain historical; remove stale branch-only wording from current truth documents.

Review authorization/operation/audit changes independently through normal PR review. Do not self-label a review as independent. If an external action, client login or paid test is blocked, finish independent work and state the exact remaining dependency instead of repeatedly requesting broad permission.

## 10. Completion ledger and deliverables

Create or update a single ledger covering **W1-01–W1-10, W2-01–W2-12 and W3-01–W3-08**. Do not mark a wave done because its UI looks complete while a backend contract remains missing.

Use these columns:

| Task | Source SHA/PR | Regression or fixture | Local checks | PR-head CI | Merged/deployed revision | Runtime/client receipt | Remaining limitation |
| ---- | ------------- | --------------------- | ------------ | ---------- | ------------------------ | ---------------------- | -------------------- |

Use separate states: not started, implemented, locally verified, CI verified, deployed, operationally accepted, or blocked with a precise dependency. A local green test does not fill deployment or native-client columns.

Required deliverables:

- Implemented changes for all 30 tasks, with any deliberate scope limitation recorded against its task.
- Updated route/navigation map and end-to-end journey notes showing what was consolidated and how legacy links behave.
- Canonical role/credential and gate-state fixtures shared across relevant UI/API/CLI/MCP tests.
- Operation/retry and automation receipts proving no duplicate side effects and no false verification.
- Local, CI, browser, database/RLS, package and exact-release acceptance evidence, clearly separated.
- Before/after interaction and performance observations; activation measurement definitions without invented conversion improvements.
- Truthful user/developer documentation and a release/rollback checklist.
- Final report: what changed, exact SHAs/PRs, tests, deployment state, client coverage and every remaining blocker. No blanket “everything works seamlessly” claim without the corresponding evidence.

## 11. Paste-ready instruction for the implementing agent

> Implement `docs/plans/2026-09-09-product-simplification-coding-handoff.md` end to end: all Wave 1, Wave 2 and Wave 3 tasks. First fetch GitHub, preserve all files/worktrees, inspect the current #637 baseline and read repository instructions. The founder selected Option 3: every active member has operational read/write access, while administrative permissions, credential scope, target authorization, budgets, RLS, audit and revocation remain enforced. Reuse existing components and domain services. Remove redundant LyraShield review steps, preserve historical contracts and never invent client support. Add regressions, complete local/database/browser/CI checks, maintain the task ledger and follow normal PR/deployment gates. Do not recreate billing staging, run paid scans/payments, auto-merge fix PRs or claim unverified release/client acceptance. Work through dependencies autonomously; ask only for genuinely missing external authorization or access after completing independent work.
