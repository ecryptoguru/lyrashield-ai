# LyraShield AI UX V2 — Coding-Agent Build Spec

Phase-by-phase implementation spec for the UX V2 upgrade, grounded in lyrashield-ai @ 33f0c28 and lyrashield-engine @ 3e07193. Incorporates the six locked founder decisions (2026-07-29) and the verified filesystem/Redis progress transport. Planning artifact — no code changed.

## 1. Locked Decisions and Scope

Baselines reviewed: web monorepo `ecryptoguru/lyrashield-ai` @ main `33f0c28`; engine `ecryptoguru/lyrashield-engine` @ `3e07193`. This document is the authoritative build spec for UX V2 and supersedes the strategy document wherever they disagree on implementation detail. The strategy document remains authoritative on product intent.

### Founder decisions locked 2026-07-29 (Ankit)

| #   | Decision                                                                                      | Consequence                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Product = existing `Project` record. No new domain tables.**                                | Product / Asset / Environment become a presentation layer over `Project` / `Target` / `Target.environment`. Zero FK migrations.        |
| 2   | **Adopt softer radii (12/16px) across app AND marketing.**                                    | Phase 1 carries a deliberate visual-identity change applied to both `apps/web` and `apps/marketing`, with before/after screenshots.    |
| 3   | **Engine progress PR approved**, rescoped after verification.                                 | In-run progress ships with no new engine telemetry; the engine PR is hardening only and is non-blocking. See section 16.               |
| 4   | **Release verdict appears on the PUBLIC trust record.**                                       | `buildScorecardPayload` allowlist change, new frozen key set, deliberately-updated regression test. Security-critical. See section 12. |
| 5   | **Notification setup moves to the active-run screen** (agent judgment, per "do what's best"). | Removed from the onboarding sequence. Activation clock stays clean; opt-in is requested while the user is already waiting.             |
| 6   | **Web push deferred to post-default-rollout** (agent judgment).                               | Phase 8 ships in-app plus email only. Push becomes a Stage 4 follow-on with its own VAPID/service-worker scope.                        |

### New tables permitted in V2 (exhaustive)

`NotificationPreference` (Phase 8) and one nullable JSON column `Project.trustPlan` (Phase 4). Nothing else. `PushSubscription` is deferred with web push. Any coding agent that believes it needs another table stops and asks the founder.

### Out of scope for V2

Enterprise GRC, SOC dashboards, policy engines, new integrations beyond what exists, compliance certification claims, unrestricted autonomous PRs, a generic chatbot, marketplace. Billing widgets and subscription-conversion metrics are also out: `product.md` records billing and plan quotas as not implemented, so the strategy's desktop "monthly usage" card and paid-conversion metric are dropped or wired read-only to existing `UsageRecord` rows.

### Recommended execution order

Phase 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 as numbered below. Note this reorders the strategy's numbered list: GitHub onboarding and the first-run flow (here Phases 2 and 3) come BEFORE the Products presentation layer (here Phase 4), because onboarding moves the headline activation metric and does not depend on the Products UI once Product equals Project.

## 2. Ground Truth — Verified Repo State

Every claim below was read from the repos. Coding agents should trust this section over their own assumptions, but must re-read a file before editing it.

### Already built (do NOT rebuild)

| Capability              | Where                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product grouping        | `Project` model, `packages/db/prisma/schema.prisma`; route `/dashboard/projects`                                                                                                                                                                            |
| Environments            | `Target.environment` enum: LOCAL, PREVIEW, STAGING, PRODUCTION                                                                                                                                                                                              |
| Release verdict engine  | `/dashboard/launch-readiness` + `launch-readiness-client.tsx` + `/api/launch-readiness`                                                                                                                                                                     |
| Control coverage counts | `ScanCoverageReceipt` model, enum `ScanCoverageStatus`: COMPLETED, NOT_APPLICABLE, BLOCKED, TIMED_OUT, FAILED                                                                                                                                               |
| Approval backend        | `AgentApproval` model with single-use `inputHash`, enum `ApprovalStatus`: PENDING, APPROVED, EXECUTED, DENIED, EXPIRED; `packages/db/src/agent-approval-service.ts`                                                                                         |
| Notification records    | `Notification` model (channel, type, title, body, status, sentAt); `packages/db/src/notification-service.ts`                                                                                                                                                |
| Public share system     | `ScorecardShare` (slug, frozen `publicPayload`, `revokedAt`, advisory-locked single active share per snapshot), `ScorecardEvent` (dedup on shareId+eventType+channel+visitorHash+dayBucket), `/score/[slug]`, `/score/methodology`, `/api/og`, `/api/badge` |
| Referrals               | `ReferralCode`, `ReferralAttribution`, `apps/web/src/app/onboarding/referral-claim.tsx`                                                                                                                                                                     |
| Lite Check              | `apps/marketing/src/pages/scan.astro` plus `HomeLiteScan.astro` homepage embed; app route `/lite-check`                                                                                                                                                     |
| Friendly run presets    | `apps/web/src/lib/scan-presets.ts` — Release check to LAUNCH_REVIEW/SAFE, Code review to TEST_APP/STANDARD, Deep security review to FULL_PENTEST/DEEP                                                                                                       |
| Adaptive polling        | `scans-client.tsx`: 10s for 60s, then 30s to 5min, then 60s; ETag/304; pauses on `document.hidden`                                                                                                                                                          |
| Bottom-sheet primitive  | `apps/web/src/components/ui/sheet.tsx` (Radix Dialog, all four sides)                                                                                                                                                                                       |
| Reduced motion          | `apps/web/src/app/globals.css` global animation kill                                                                                                                                                                                                        |
| SSRF guard              | `apps/web/src/lib/ssrf.ts` `checkScanUrlSafe`                                                                                                                                                                                                               |
| Audit trail             | `AuditLog` with hash chaining, `packages/db/src/audit-hash.ts`                                                                                                                                                                                              |

### Genuine gaps

- No `middleware.ts`. Auth and onboarding gating live in `apps/web/src/app/(dashboard)/layout.tsx` via `getCachedSession()` and `getCachedOnboardingState()`. Old-to-new route redirects therefore belong in `next.config`, and feature-flag evaluation belongs in that layout.
- No feature-flag system of any kind.
- No product analytics in `apps/web`. PostHog exists only in `apps/marketing/src/layouts/Base.astro` (`landing_view`, `cta_click`, `faq_open`, privacy-bounded pageviews, autocapture off, DNT/GPC respected).
- No `NotificationPreference` model. `DEFAULT_CHANNELS` in `notification-service.ts` is in_app, slack, discord — email is the `Notification.channel` column default but is not in that constant.
- No `env(safe-area-inset-*)` anywhere. No bottom-nav component.
- `e2e/critical-flow.spec.ts` has no viewport matrix and no `toHaveScreenshot()` assertions.
- `job.updateProgress()` is never called in `apps/worker`.
- No `durationMs` column on `Scan`; duration is only derivable as `endedAt - startedAt`.

### Current navigation and the routes it hides

`apps/web/src/components/sidebar.tsx` holds a single `navItems` array (no config file): Overview, Targets, Scans, Findings, Fix proposals, Reports, Settings. These routes exist but are NOT in the nav: `launch-readiness`, `integrations`, `notifications`, `projects`, `schedules`, `team`. Part of V2's value is re-exposing what already ships.

### Enums (verbatim, do not invent values)

```
ScanGoal:    CHECK_PR, TEST_APP, LAUNCH_REVIEW, WEEKLY_MONITOR, FULL_PENTEST, COMPLIANCE_REVIEW
ScanMode:    SAFE, QUICK, STANDARD, DEEP, CUSTOM
ScanStatus:  QUEUED, PREFLIGHT, RUNNING, VERIFYING, COMPLETED, FAILED, CANCELLED,
             REQUIRES_APPROVAL, STOPPED_BUDGET, TIMED_OUT
FindingSeverity: INFO, LOW, MEDIUM, HIGH, CRITICAL
FindingStatus:   OPEN, FIX_READY, PR_OPENED, TICKET_CREATED, FIXED_PENDING_RETEST,
                 FIXED, ACCEPTED_RISK, FALSE_POSITIVE, DUPLICATE
FindingVerificationStatus: DETECTED, VALIDATED, VERIFIED, BLOCKED, INCONCLUSIVE
TargetEnvironment: LOCAL, PREVIEW, STAGING, PRODUCTION
TargetType:  REPO, WEB_APP, API, CLOUD_ACCOUNT, CONTAINER, IAC
```

### Stack

Next 16.2.11, React 19.2.8, Tailwind 4.3.3 (no `tailwind.config.ts` — theme lives in `@theme` inside `globals.css`), TypeScript 6, shadcn/ui new-york on Radix, lucide-react 1.26. Shared primitives in `packages/ui/src` (button, card, badge, form-field, empty-state, spinner, load-more). 27 migrations, latest `20260725160000_scan_workspace_status_index`.

## 3. Non-Negotiable Rules for Coding Agents

### Engineering discipline

1. **Inspect before you change.** Read the actual file. This spec's paths are verified but line-level content may have moved.
2. **Smallest high-quality change.** No opportunistic refactors outside the phase's stated scope.
3. **Verify by execution.** Every phase ends green on typecheck, lint, unit tests, build, and the responsive Playwright matrix. Use the scripts declared in the root `package.json` and `turbo.json` — read them, do not guess names.
4. **Branch plus PR. Never push to main.** One branch per phase, named `feat/uxv2-p<N>-<slug>`.
5. **Migrations require founder approval before running anywhere but local.** V2 permits exactly two schema changes (section 1).
6. **Stop and ask** before anything public, destructive, production-touching, or payment-related.

### Security-critical zones — NOT to be delegated to routine subagents

These stay with the lead agent, with a founder heads-up on any change:

- `packages/db/src/score-service.ts`, specifically `buildScorecardPayload` and its regression test in `score-service.test.ts`. This is the ONLY permitted constructor of a public payload. The test asserting the exact key set is load-bearing. If a task appears to require weakening it, the task stops.
- `AgentApproval` semantics. The single-use `inputHash` guarantee must survive the Approval Centre redesign.
- RLS: `packages/db/src/rls.ts`, `extension.ts`, `system-client.ts`. The last four migrations exist to tighten workspace-scoped RLS; do not introduce a table or query path that bypasses `app.current_workspace_id`.
- The audit-log hash chain (`packages/db/src/audit-hash.ts`).
- `apps/web/src/lib/ssrf.ts` and every URL intake path.
- `apps/worker/src/engine/runner.ts`, especially `buildEngineEnv`. See the env allowlist rule below.
- Notification and email content assembly (no finding detail may leave an authenticated view).

### Hard prohibitions

- **Never add `REDIS_URL`, queue credentials, or any secret to the `buildEngineEnv` allowlist** in `apps/worker/src/engine/runner.ts`. That allowlist is deliberate: the engine ingests untrusted repository content and must not hold queue credentials. Progress crosses that boundary via the filesystem only.
- **Never surface model cost or spend in any user-facing surface.** `product.md`: "Protected run limits and versioned per-request GPT-5.6 accounting remain internal; the dashboard shows neither model costs nor spend." Token counts and cap values may be used internally to compute an expected-work fraction; they may not be rendered.
- **Never surface in-run candidate counts.** `vulnerabilities.json` is written incrementally with unverified candidates. Showing "3 issues found" mid-run would destroy the detected-versus-verified distinction that is the product's central differentiator.
- **Never rename an integration contract.** API route paths, MCP tool names, GitHub Action inputs/outputs, SARIF fields, CLI flags, and the public methodology vocabulary stay as they are. UI labels are free to change (section 4).
- **Never hardcode a number that looks measured.** Control counts, coverage figures, resolved-issue counts and verdicts must derive from `ScanCoverageReceipt`, `FindingVerification`, or stored durations. No placeholder numerics reach a shipped screen.

### Copy-safety gate (applies to every phase)

Every new user-facing string containing a number or a verdict must trace to a stored record. Positive verdicts keep their scope qualifier — "Ready to ship within completed scope", never a bare "Ready". Avoid the strategy's looser phrasings where they conflict with `product.md` guardrails: do not claim uniqueness, do not publish benchmark or accuracy claims, do not present the forked engine as a differentiator. Final landing and hero copy routes through the marketing agent and founder approval before merge.

### Delegation guidance

Routine mechanical work suited to subagents: markup and Tailwind conversions, skeleton components, test scaffolding, single-file formulaic edits, screenshot baselining, copy-map extraction. Everything in the security-critical list above, plus the estimator design and the worker progress reader, stays with the lead.

## 4. Terminology, Routes and Redirect Map

### Single copy module

Create `apps/web/src/lib/terminology.ts` exporting every user-facing noun as named constants (for example `RUN_SINGULAR`, `RUN_PLURAL`, `ISSUE_SINGULAR`, `PRODUCT_SINGULAR`, `ASSET_PLURAL`). All V2 screens import from it. No component hardcodes "Trust Run" or "Issue" inline. A future rename is then one file.

Internal identifiers, Prisma models, enum values, API payload keys and integration contracts keep their current names (`Scan`, `Finding`, `Target`, `Project`). The mapping lives only in this module.

| Internal entity      | V2 user-facing label                  |
| -------------------- | ------------------------------------- |
| Scan                 | Trust Run                             |
| Finding              | Issue                                 |
| Project              | Product                               |
| Target               | Asset                                 |
| `Target.environment` | Environment                           |
| FixProposal          | Proposed fix (nested inside an Issue) |
| Report               | Evidence record                       |
| Schedule             | Automation                            |

### Route policy — aliases, not renames

Existing URLs appear in already-sent notification emails, generated reports, and bookmarks. Keep them canonical; add aliases where the IA changes.

| Route                                                             | Action                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard`                                                      | Stays. Becomes the Trust Command Center.                                                                                                  |
| `/dashboard/scans`, `/dashboard/scans/[id]`                       | **Canonical, unchanged.** Add `/dashboard/runs` and `/dashboard/runs/[id]` as `next.config` rewrites to the same segments.                |
| `/dashboard/findings`                                             | **Canonical, unchanged.** Add `/dashboard/issues` alias.                                                                                  |
| `/dashboard/targets`, `/dashboard/targets/[id]`                   | **Redirect (308)** to `/dashboard/products` and `/dashboard/products/[id]`. This is the one genuine IA move.                              |
| `/dashboard/projects`                                             | Redirect to `/dashboard/products`.                                                                                                        |
| `/dashboard/fixes`                                                | Redirect to `/dashboard/issues`. Fix proposals stop being a top-level destination and appear inside issue detail and the Approval Centre. |
| `/dashboard/reports`                                              | Redirect to `/dashboard/evidence`.                                                                                                        |
| `/dashboard/launch-readiness`                                     | Keep as a deep link; its content is promoted into `/dashboard` and product detail.                                                        |
| `/dashboard/approvals`                                            | **New.**                                                                                                                                  |
| `/dashboard/evidence`                                             | **New**, absorbing reports.                                                                                                               |
| `/dashboard/automations`                                          | **New**, alias of `/dashboard/schedules`.                                                                                                 |
| `/dashboard/notifications`, `/integrations`, `/team`, `/settings` | Stay. Promoted into the More menu on mobile.                                                                                              |

Implement redirects in `next.config` (there is no `middleware.ts` and one should not be introduced solely for this). Add an e2e assertion that every legacy path resolves 200 or 308 to its replacement.

### Navigation targets

Mobile bottom navigation, five destinations: Home, Products, Runs, Issues, More. The More sheet contains Approvals, Evidence, Automations, Notifications, Integrations, Team, Settings.

Desktop primary: Home, Products, Trust Runs, Issues, Approvals, Evidence, Automations. Secondary: Notifications, Integrations, Team, Settings.

Both derive from ONE shared nav definition extracted out of `sidebar.tsx` into `apps/web/src/lib/nav-items.ts`, consumed by the desktop sidebar and the mobile bottom bar so labels and active-state logic cannot drift. Preserve the existing active-state rule (exact match for `/dashboard`, prefix match otherwise) and the existing `aria-current="page"` and `aria-label="Main navigation"` affordances.

## 5. Phase 0 and Phase 1 — Foundation

## Phase 0 — Baseline, flags, analytics, visual regression

**Goal:** make the next ten phases measurable, gateable and reversible. Nothing user-visible ships here. This phase is not optional scaffolding — Phase 1's acceptance criteria are unenforceable without it.

**Branch:** `feat/uxv2-p0-baseline`

### Tasks

1. **Feature flags.** No system exists. Build a minimal server-evaluated one: `apps/web/src/lib/flags.ts` exposing `getFlags(session, workspace)`. Resolution order: env allowlist (`UX_V2_INTERNAL_USER_IDS`, `UX_V2_NEW_USERS_FROM` as an ISO date) then a per-workspace override. Evaluate once in `apps/web/src/app/(dashboard)/layout.tsx` (there is no `middleware.ts`; do not add one) and pass down via a server-rendered context provider. Flags needed: `uxV2Shell`, `uxV2Onboarding`, `uxV2Runs`, `uxV2Issues`, `uxV2Evidence`, `uxV2Notifications`, `uxV2Sharing`.
2. **Fallback preservation.** Every V2 screen renders behind its flag with the current component retained on the false branch. Do not delete legacy screens until Stage 5 of the rollout.
3. **PostHog in `apps/web`.** Mirror the privacy configuration already in `apps/marketing/src/layouts/Base.astro`: `autocapture: false`, `capture_pageview: false`, session recording disabled, DNT/GPC honoured via `opt_out_capturing()`. Add a typed `track()` wrapper in `apps/web/src/lib/analytics.ts` that accepts only events from the dictionary in section 17 and strips any property not on that event's allowlist. Repo names, target URLs, finding titles, severities, file paths and captions must be impossible to send by construction — enforce with a unit test that attempts to pass a forbidden key and asserts it is dropped.
4. **Responsive Playwright matrix.** `playwright.config.ts` currently has no viewport projects and `e2e/critical-flow.spec.ts` has no screenshot assertions. Add projects at 390x844, 768x1024 and 1280x800. Add `e2e/visual/` specs with `toHaveScreenshot()` baselines for: dashboard home, products list, run detail, issue detail, onboarding step 1. Commit baselines. Wire into CI as a required check.
5. **Baseline capture.** Before any Phase 1 change, capture and commit current-state screenshots at all three viewports into `docs/uxv2/baseline/` so the visual refresh in Phase 1 is reviewable as a diff.
6. **Route and component inventory.** Commit `docs/uxv2/inventory.md` recording the route tree, the nav items, and the legacy-to-new route map from section 4. This becomes the redirect test's source of truth.
7. **Migration document.** `docs/uxv2/migration.md` recording the flag names, the rollout stages, and the fallback removal criteria.

### Acceptance criteria

- Toggling `uxV2Shell` off restores the current UI exactly, verified by screenshot equality against the committed baseline.
- The analytics wrapper rejects forbidden properties in a passing unit test.
- CI fails on a visual regression at any of the three viewports.
- No user-visible change ships in this phase.

### Verify

Root-declared typecheck, lint, unit test and build scripts, plus `playwright test` across all three projects.

---

## Phase 1 — Mobile foundation and visual refresh

**Goal:** a mobile-first shell at 390px, and the founder-approved radius change applied coherently across app and marketing.

**Branch:** `feat/uxv2-p1-mobile-shell`

### Files

- `apps/web/src/components/sidebar.tsx` — extract `navItems` out to `apps/web/src/lib/nav-items.ts`; this file becomes desktop-only presentation.
- New `apps/web/src/components/bottom-nav.tsx`, `apps/web/src/components/mobile-page-header.tsx`, `apps/web/src/components/responsive-list.tsx`.
- `apps/web/src/app/(dashboard)/layout.tsx` — shell composition and padding.
- `apps/web/src/app/globals.css` — `@theme` tokens (Tailwind 4; there is no `tailwind.config.ts`).
- `packages/ui/src/button.tsx`, `card.tsx`, `badge.tsx` — currently hardcode `rounded-[2px]`.
- `apps/marketing/src/layouts/Base.astro` and landing components — same radius change.

### Tasks

1. **Bottom navigation.** Five destinations from the shared nav definition. Fixed, with `env(safe-area-inset-bottom)` padding. Hidden at `md` and above. Must be a client component; keep it out of the server layout's data path.
2. **Safe-area handling.** No `env(safe-area-inset-*)` exists anywhere today. Add utilities in `globals.css` and apply to the bottom nav, the mobile header, and any sticky action bar. Confirm `viewport-fit=cover` is set in the root layout metadata, otherwise the insets resolve to zero.
3. **Layout padding.** `(dashboard)/layout.tsx` currently uses `pt-16 md:pt-0` for the fixed mobile topbar. Add matching bottom padding for the bottom nav so content is never occluded, and remove it at `md`.
4. **Mobile page header** with title, back affordance, and a notification bell carrying an unread indicator (wired in Phase 8; render a static zero state until then).
5. **Bottom sheets.** Reuse the existing `apps/web/src/components/ui/sheet.tsx` with `side="bottom"`. Add a thin `BottomSheet` wrapper applying consistent radius, drag affordance and safe-area padding. Use for: new run, repository selection, notifications, sharing, filters, issue actions, approvals, product switching.
6. **Radius change (decision 2).** Replace the five `--radius-*` tokens in `globals.css` — all currently `0.125rem` — with: cards 12px, dialogs and sheets 16px, inputs 10px, buttons 10px, chips full. Remove the hardcoded `rounded-[2px]` from `packages/ui` primitives so they consume tokens instead. Apply the same scale to `apps/marketing`. Deliver as ONE commit with a before/after screenshot set at 390, 768 and 1440 attached to the PR for founder sign-off.
7. **Touch targets.** Buttons are already `h-11` (44px) and `size-11` for icon variants — verify, do not regress. Audit inline links and icon-only controls in tables and cards, which are the likely offenders.
8. **Responsive list primitive.** One component rendering a table at `md` and above and cards below, so the Products, Runs and Issues screens all convert consistently instead of each hand-rolling breakpoints.
9. **Mobile skeletons.** Extend the existing `ui/skeleton.tsx` into per-screen skeletons matching the card layouts, so loading states do not shift layout.
10. **Accessibility.** Add the missing skip link to `apps/web/src/app/layout.tsx` (marketing has one, the app does not). Preserve existing `aria-label="Open navigation menu"`, `aria-label="Main navigation"`, `aria-current="page"`, the screen-reader-only sheet header, and the `prefers-reduced-motion` block. Bottom nav needs keyboard reachability and a visible focus ring.

### Acceptance criteria

- No primary route horizontally scrolls at 320px. `body` already sets `min-width: 320px`; test at exactly 320 and 390.
- Every primary action has a target of at least 44px.
- Layouts verified at 390, 768, 1024 and 1440.
- Bottom sheets usable in portrait; dismissible by keyboard.
- Safe-area padding correct on a notched viewport (Playwright device emulation with insets).
- Bottom nav is keyboard-navigable and screen-reader-announced.
- Radius change applied to app and marketing with no orphaned `rounded-[2px]` remaining.
- Visual-regression baselines updated deliberately in the same commit as the radius change, never silently.

### Verify

Full matrix plus a manual one-handed pass through: home, start a run, open a run, open an issue.

## 6. Phase 2 and Phase 3 — Onboarding and First Run

## Phase 2 — Autonomous GitHub onboarding

**Goal:** sign-up to first review started in under three minutes, with the user never retyping anything GitHub already told us.

**Branch:** `feat/uxv2-p2-github-onboarding`

### What is wrong today (verified)

`apps/web/src/app/onboarding/onboarding-wizard.tsx` has three phases: type a workspace name and pick VIBE or TEAM; pick REPO or URL and **manually type `repoOwner` and `repoName`**; confirm and start a SAFE scan. The GitHub repo picker exists only at `/dashboard/integrations` (`github-integration.tsx`) and requires an explicit **"Load repositories"** click. Onboarding never consults the integration. `listInstallationRepos` already returns `id`, `fullName`, `name`, `owner`, `defaultBranch`, `private`, `htmlUrl` — so owner, name and default branch are all known and are being retyped by hand.

### Tasks

1. **Reorder: connect GitHub before naming anything.** New step 1 offers Connect GitHub (primary), Add a website (secondary), Explore a demo product (tertiary). Workspace creation is deferred.
2. **Auto-create the workspace from `integration.accountLogin`.** After install, create the workspace named from the GitHub account and mark it renameable. Remove the workspace-name text input from the happy path entirely; expose renaming in Settings. Keep the VIBE/TEAM choice but default it and move it out of the critical path.
3. **Auto-fetch repositories on return from install.** Delete the "Load repositories" button from the onboarding path. Show skeletons immediately on mount and fetch `GET /api/integrations/github/repos` without user action. Preserve the existing `state`-token verification in `/api/integrations/github/install` — including the current fail-safe that redirects to `?github=verification_required` when no integration record exists. Do not weaken it.
4. **Repository search and multi-select.** Client-side search over the fetched list. Sections: Recommended (most recently pushed, plus any repo whose name matches the workspace) and Recently updated. Multi-select with checkboxes.
5. **Repo cards show detected metadata,** not blanks: language and default branch from the GitHub payload, visibility, and last-updated. Add `language` to the fields mapped in `/api/integrations/github/repos` — GitHub returns it and it is currently dropped.
6. **Lightweight framework detection, best-effort only.** Read the repository's root file list plus `package.json` via the installation client to infer framework and package manager. Cache on the target. If detection fails, omit the label rather than guessing — never display an unverified framework as fact.
7. **Grouping into one Product.** Selecting N repos creates one `Project` (the Product) and N `Target` records under it, with `branch` prefilled from `defaultBranch` and `environment` defaulted to STAGING. Reuse `CreateRepoTargetSchema` in `packages/types/src/index.ts` unchanged.
8. **Suggested applications — suggest-only, security-critical (see below).**
9. **Advanced manual fallback** stays available under a collapsed "Advanced setup" disclosure, preserving today's manual owner/name path for users without the App installed.
10. **Redirect straight to trust-plan confirmation** (Phase 3), carrying the selected product. Never bounce the user to a separate scans page.
11. **Error handling** must preserve the user's repo selection across a failed create and allow retry. Installation-scope limits (App installed on only some repos) must be explained inline with a link to adjust GitHub App access.

### Security gates

- **Suggested domains must never be auto-added.** Inferring `lyrashieldai.com` from repo metadata does not establish authorization to test it. Requirement: suggestions render **unchecked**; adding one requires an explicit ownership/authorization attestation captured in the UI and written to `AuditLog`; `checkScanUrlSafe` from `apps/web/src/lib/ssrf.ts` runs on intake; and no suggested asset may be included in any run until that attestation exists. This is the largest authorization risk in the whole programme — do not soften it for conversion.
- Private repository metadata must not leak outside the workspace: no repo names in analytics events, no repo names in any public payload, no repo names in notification bodies.
- The install `state` token flow and its workspace binding stay intact.

### Acceptance criteria

- A user with the App installed never types an owner or a repo name by default.
- `branch` is populated from `defaultBranch` without user input.
- Selecting repositories creates the underlying `Project` and `Target` rows correctly, verified by an integration test.
- A failed create preserves selection and offers retry.
- Suggested domains cannot become scannable assets without an attestation, verified by a test asserting a run refuses an unattested suggested asset.
- Measured sign-up-to-review-started under three minutes for a normal repo on a seeded fixture.

---

## Phase 3 — Trust plan, first run, and the time estimator

**Goal:** one recommended plan, a truthful pre-run expectation, and the run started from onboarding.

**Branch:** `feat/uxv2-p3-trust-plan`

### Tasks

1. **Recommended plan UI.** Map onto the existing presets in `apps/web/src/lib/scan-presets.ts` — do not invent new backend modes. Before releases maps to Release check (LAUNCH_REVIEW / SAFE); the weekly items map to `WEEKLY_MONITOR`, which is already defined in the preset file but currently not offered in the UI — surface it. Deep Trust Review maps to the existing DEEP preset. QUICK and CUSTOM stay backend/API-only per `product.md`; do not expose them.
2. **Persist the plan** as `Project.trustPlan Json?` — the single permitted new column. Store a versioned shape (`{ version, preRelease: string[], recurring: [{ preset, cron }] }`). Recurring items create rows in the existing `Schedule` table via `packages/db/src/schedule-service.ts`. Do not build a parallel scheduler.
3. **Internal parameters stay hidden.** Scan modes, goals, `determinismMode` (`DeterminismModeSchema`: default, strict, best-effort, targeted_scanner, targeted_engine — currently surfaced nowhere), model routes and evidence profiles remain invisible unless Advanced is opened.
4. **Pre-run summary screen:** product, scope (N repositories, M apps), expected completion range, notification state, one primary Start button.
5. **Time estimator, tier 1.** Add migration for an indexed `durationMs` column on `Scan`, backfilled from `endedAt - startedAt` for completed scans. Capture repository size at PREFLIGHT — the installation client already returns the GitHub `size` field, so this is nearly free — and store it on the target or the scan for bucketing. Build `apps/web/src/lib/run-estimate.ts` computing a p50-to-p80 range grouped by `(mode, targetType, sizeBucket)`. Require a minimum sample count before showing a learned range; below it, fall back to a size-based cold-start range.
6. **Copy rules for estimates.** Before execution: "Estimated completion: 8–14 minutes". With history: "Usually completes in 9–12 minutes for this product". Cold start: "Expected range based on repository size: 10–20 minutes". High variance: "Timing may vary while deeper verification runs." **Never** show second-level precision, and never show a percentage unless it represents real completed work units.
7. **Start the run from onboarding** via the existing `POST /api/scans`, then land on the run screen. Preserve the existing enqueue admission behaviour: full-scan admission fails closed without a live worker heartbeat, and every enqueue path shares the same unavailable response. If admission fails, the UI must say so plainly and offer retry rather than appearing to have started.
8. **Notification setup moves here (decision 5)** — offered on the active-run screen, not before the run. Phase 8 implements it; Phase 3 leaves the slot.

### Acceptance criteria

- First review starts without navigating to a separate scans page.
- An expected range appears before execution and is derived from stored data, never hardcoded.
- Internal modes remain hidden unless Advanced is opened.
- The estimator degrades gracefully with zero history.
- Worker-unavailable admission failures are surfaced honestly.
- `durationMs` backfill verified on a seeded dataset; the migration is reviewed and founder-approved before any non-local run.

## 7. Phase 4 and Phase 5 — Products, Home, and Trust Runs

## Phase 4 — Products presentation layer and the Trust Command Center

**Goal:** a coherent Product model and a Home screen that leads with a decision — both built entirely over existing tables.

**Branch:** `feat/uxv2-p4-products-home`

### Rule: presentation only

Product is `Project`. Asset is `Target`. Environment is `Target.environment`. No new tables beyond `Project.trustPlan` from Phase 3. Do NOT re-point `targetId` foreign keys: `Target` is the anchor for scans, findings, snapshots, schedules, candidates and credentials, carries `@@unique([workspaceId, repoFullName])` and `@@unique([workspaceId, url])`, and every RLS policy joins through `workspaceId`. Introducing a mid-tier entity would break that pattern for no user-visible gain.

Introduce a UI-layer type in `apps/web/src/lib/product-model.ts` that reads `Project` with its `Target[]` and adapts them into Product / Assets / Environments shapes. All V2 screens consume that adapter, never raw Prisma shapes, so a future real migration is a one-file swap.

### Tasks — Products

1. Product list at `/dashboard/products` using the Phase 1 responsive list: name, asset counts, production evidence freshness, verdict badge, issues-needing-attention count. Actions: Open, Start review, More.
2. Product detail at `/dashboard/products/[id]` with segmented navigation: Overview, Assets, Trust Plan, Activity, Evidence.
3. Assets tab groups by `Target.environment` (LOCAL, PREVIEW, STAGING, PRODUCTION).
4. Asset discovery: with GitHub connected, newly accessible repositories appear as suggestions marked "not protected"; already-added ones marked protected. Same attestation rule as Phase 2 applies to any suggested non-repo asset.
5. Add-product flow reusing the Phase 2 components: Connect GitHub, Add repository, Add website, Add API. Manual fields under Advanced setup.
6. Implement the section 4 redirects in `next.config` plus an e2e test asserting every legacy path resolves.

### Tasks — Home

7. **Extract the verdict engine.** Refactor the computation behind `/dashboard/launch-readiness` and `/api/launch-readiness` into a deterministic, versioned module — `packages/score/src/verdict.ts` or a sibling, mirroring how the score engine is versioned as `lyrashield-score/1.0.0`. Emit `{ verdict, verdictVersion, inputs }`. One implementation must back Home, product detail, the completed-run screen, and (Phase 7) the public record. Do not write a second verdict path.
8. **Verdict values:** `GO`, `GO_WITH_CONDITIONS`, `NOT_READY`, plus `INSUFFICIENT_EVIDENCE` for the not-yet-reviewed case. All copy carries the scope qualifier.
9. **Home hierarchy:** verdict, then required actions (issues needing attention, approvals waiting, evidence freshness), then "LyraShield is working" activity, then what changed, then supporting analytics. Desktop adds trend, coverage, recent runs, issue distribution. Drop the monthly-usage widget (billing is not implemented) or wire it read-only to `UsageRecord`.
10. **Home states:** not configured, ready to review, running, approval required, issues blocking release, ready within completed scope. Every number derives from `ScanCoverageReceipt`, `FindingVerification` or stored durations.
11. **One aggregate endpoint.** Build `/api/home-summary` returning everything Home needs, with ETag support, consumed by the existing adaptive-poll hook pattern and paused on `document.hidden`. Do not fan out one fetch per widget — Deep Review v5 cost discipline applies.

### Acceptance criteria

- Every capability reachable before V2 is still reachable.
- No data migration required for rollout.
- Existing targets render as assets under products.
- Legacy URLs resolve 200 or 308.
- Home issues exactly one data request per poll tick and none while hidden.
- The same verdict module produces the verdict everywhere it is displayed, asserted by a shared unit test.

---

## Phase 5 — Trust Runs UX and live progress

**Goal:** a narrative run experience with an honest remaining-time signal, using the verified transport.

**Branch:** `feat/uxv2-p5-trust-runs`

### The progress transport (verified design — implement exactly this)

**Engine to worker: filesystem only.** `apps/worker/src/engine/runner.ts` spawns the engine with `env: buildEngineEnv(profile)`, an explicit ~28-key allowlist that does not spread `process.env`; `REDIS_URL` is deliberately absent. The engine runs in the same container as the worker (Docker-in-Docker is used only for the inner scan sandbox), and outputs land under `LYRASHIELD_ENGINE_WORK_ROOT` at `lyrashield_runs/<scanId>/strix_runs/<scanId>/`. **Never add Redis credentials to that allowlist.**

**The engine already emits an in-run signal.** `strix/report/state.py` calls `ReportState.save_run_data()` on every SDK usage event (`record_sdk_usage`) and every finding (`add_vulnerability_report`), rewriting `run.json` live. `run.json` therefore carries a monotonically increasing `llm_usage.request_count` and token buckets throughout RUNNING. No new engine telemetry is required.

**Implementation:**

1. Worker polls `run.json` every ~10s during RUNNING. Parse defensively — the file is rewritten wholesale, so a torn read is possible; on parse failure skip the tick and retry.
2. Validate with zod at the boundary, with the same rigour as `apps/worker/src/engine/engine-output-schema.ts`. All numbers are untrusted: reject NaN, negatives and absurd magnitudes; clamp before use. A compromised engine must not be able to drive the UI or Redis with junk.
3. Worker writes a scrubbed record to Redis key `lyrashield:scan-progress:<scanId>` with `PEXPIRE` ~120s. Follow the existing convention in `packages/integrations/src/queue.ts` (which uses sorted set `lyrashield:scan-workers`). The short TTL means a dead worker's stale progress disappears and the UI degrades to "Timing may vary".
4. Also call BullMQ `job.updateProgress()` — never called anywhere in `apps/worker` today — for operational visibility. The API reads the dedicated key, not the job hash, to avoid a jobId lookup and web-side queue coupling.
5. **Progress payload allowlist, exhaustive:** `seq`, `phase`, `elapsedMs`, `llmRequestCount`, `expectedWorkFraction`, `updatedAt`. Excluded: cost or spend of any kind, raw token counts, cap values, file paths, target or repo identity, and anything derived from `vulnerabilities.json`.
6. `ScanEvent` rows for coarse milestones only (phase transitions). Never per tick — the detail endpoint already reads up to 200 event rows.

### Two traps that must be covered by tests

- **ETag masking.** `scanEtag()` in `apps/web/src/app/api/scans/[id]/route.ts` hashes only `{ id, status, updatedAt, eventsCount, lastEventAt }`. Progress living in Redis is invisible behind 304s — the client polls, gets 304, and the counter never moves. Add the heartbeat `seq` to the ETag payload, with a test asserting the ETag changes when only progress advances.
- **Cost disclosure.** Assert by test that no cost, spend or token field can reach the run API response.

### Tasks — UI

7. Rename Scans to Trust Runs via the terminology module; keep `/dashboard/scans` canonical with the `/dashboard/runs` alias.
8. Narrative stage timeline derived from the existing `ScanEvent.stage` values — `queued`, `preflight`, `running`, `billable_boundary`, `verifying`, `scanners_complete`, `findings_persisted`, `llm_usage`, `engine_terminal`, `coverage_contract` — mapped to user-facing stage names in the terminology module. Show completed, working now, and next.
9. Remaining-time range from the estimator plus `expectedWorkFraction`. If progress is unavailable (expired key, worker died), show elapsed plus the static range and the variance caveat. Never fabricate a countdown.
10. Contextual intelligence lines are permitted only when derived from real signals (for example, an agent-permission review was added because the repo uses tool calling) — sourced from coverage receipts or scanner events, not from prose templates.
11. "You can close this page. The review will continue." messaging, and return-state restoration so leaving and returning restores the same view.
12. Reorder the completed-run screen: release decision, what changed, next action, issue summary, coverage and evidence, then technical detail. Lazy-load the technical sections.
13. Keep the existing adaptive polling intervals and `document.hidden` pause. Do not add a second polling layer.

### Acceptance criteria

- The active stage is always unambiguous.
- The time range updates without fake progress; no second-level precision anywhere.
- Leaving and returning preserves state.
- Terminal states offer exactly one primary action.
- Coverage limitations remain visible on the completed screen.
- Progress survives a worker restart by degrading, not by lying.
- The four deterministic scanners running in parallel during VERIFYING are represented as one verification stage, not four sequential ones.

## 8. Phase 6 and Phase 7 — Issues, Approvals, Evidence

## Phase 6 — Issues and the Approval Centre

**Goal:** a non-security user can identify impact and next action, and every sensitive action routes through one reviewed inbox.

**Branch:** `feat/uxv2-p6-issues-approvals`

### Tasks — Issues

1. Rename Findings to Issues in the UI only, via the terminology module. `Finding` stays the model name; `/dashboard/findings` stays canonical with an `/dashboard/issues` alias.
2. Issue card: severity label, plain-language title, verification state, affected area, and whether a recommended action exists.
3. Issue detail hierarchy: header, impact in plain language, recommended action, expected effort, primary action, lifecycle, then a collapsed technical section. Preserve the existing drawer's separation of what-to-do, technical, and history — this is already right; simplify it visually rather than restructuring it.
4. **Verification states must stay distinct.** `FindingVerificationStatus` is DETECTED, VALIDATED, VERIFIED, BLOCKED, INCONCLUSIVE, and `FindingVerificationMethod` records how (ENGINE_CLAIM, SCANNER_DETECTION, SOURCE_RULE, DEPENDENCY_ADVISORY, URL_CHECK, RETEST, HUMAN_REVIEW). Never collapse these into a single confident label, and never present an engine claim as independently verified — `product.md` records that engine findings are not self-verified.
5. Lifecycle timeline from the real `FindingStatus` transitions: OPEN, FIX_READY, PR_OPENED, TICKET_CREATED, FIXED_PENDING_RETEST, FIXED, ACCEPTED_RISK, FALSE_POSITIVE, DUPLICATE. Surface the persisted status reason for accepted-risk and false-positive (the column already exists from `20260725132208_add_finding_status_reason`).
6. Effort estimates are phrased as likelihood, never as a guarantee.
7. Technical section, lazily loaded: evidence, files, line locations, CWE, CVSS/CVSS3, verification method and receipt, scanner provenance, history. `Evidence` rows point to storage URIs with redaction status — respect `redactionStatus` and prefer the redacted URI wherever one exists.
8. Sticky mobile action bar for the primary issue action.

### Tasks — Approval Centre

9. New `/dashboard/approvals` over the existing `AgentApproval` model. Do not create a new approvals table.
10. **Preserve single-use semantics.** `AgentApproval` carries `inputHash` and `ApprovalStatus` (PENDING, APPROVED, EXECUTED, DENIED, EXPIRED) with an advisory lock in `packages/db/src/agent-approval-service.ts`. The redesign must not allow an approval to be replayed, must not approve a mutated payload against a stale hash, and must respect `expiresAt`. Any change to this file is lead-agent work with a founder heads-up.
11. Approval card: what will happen, the issue it relates to, files affected, risk level, and Review changes / Approve / Reject. Diffs render read-only.
12. Approval taxonomy (`actionName` values) covering: apply or create a fix, create a pull request, run an intrusive assessment, publish a trust record, share repository identity, accept risk, change monitoring, connect a production asset, invite a user.
13. Guided Autonomy policy display: routine checks automatic; fix proposals automatic; code changes, public sharing and intrusive testing require approval.
14. Every approve/reject writes an `AuditLog` entry through the existing hash chain. Role-awareness uses the existing `MemberRole` enum; publishing and production-policy changes should be restricted to OWNER/ADMIN-class roles.
15. Fix proposals stop being a top-level nav destination; they appear inside issue detail and here. `/dashboard/fixes` redirects.

### Guardrail

`product.md` records server-generated approval-bound PR patches as **not implemented**. The Approval Centre must therefore not promise automatic PR creation for capabilities that do not exist yet — render only the approval types that are actually wired, and keep the rest out of the UI until they ship.

### Acceptance criteria

- A non-security user can state the impact and the next action from the issue detail without expanding the technical section.
- Technical evidence remains fully available.
- No sensitive automated action executes without an approval record.
- Every approval has an audit entry; the hash chain still verifies.
- An approval cannot be replayed or applied to a mutated payload, asserted by test.
- Mobile issue actions remain reachable without scrolling.

---

## Phase 7 — Evidence, and the public verdict disclosure

**Goal:** evidence becomes something maintained, not generated on request — and the release verdict becomes shareable, safely.

**Branch:** `feat/uxv2-p7-evidence`

### Tasks — Evidence

1. New `/dashboard/evidence`; `/dashboard/reports` redirects. Reuse `packages/db/src/report-service.ts` and `report-generator.ts`; do not write a second generator.
2. Evidence home shows: product, current verdict, evidence freshness, coverage (evaluated of applicable controls, from `ScanCoverageReceipt`), and issue state counts split by verification state. Actions: Share, Download, View methodology, Compare release, Review evidence gaps.
3. Reframe the existing report types as audience views — founder, developer, customer, compliance, public trust record — automatically maintained rather than manually generated.
4. Automatic refresh on: completed release review, completed retest, verdict change, scheduled review, newly verified issue, evidence expiry. `ScoreSnapshot` already carries `expiresAt` with a 30-day TTL — drive staleness from it rather than inventing a second clock.
5. Freshness and scope indicators must state limitations, including which controls were BLOCKED, TIMED_OUT or NOT_APPLICABLE. Coverage is never rounded up.
6. Comparison view diffing two snapshots for the same product.
7. Revocation: `Report.revokedAt` and `ScorecardShare.revokedAt` already exist. Revoked links must stop resolving immediately — no cached public render may survive revocation. Add a test that fetches a share, revokes it, and asserts the next fetch fails.

### Tasks — Public verdict (decision 4, SECURITY-CRITICAL)

The founder approved putting the release verdict on the public trust record. This is a disclosure change to the one allowlisted public payload constructor and must be executed exactly as follows.

8. `buildScorecardPayload` in `packages/db/src/score-service.ts` is currently the sole constructor of the public payload and returns exactly five keys: `grade`, `scope`, `scannedAt`, `modelVersion`, `resolvedFindings`. Add exactly two: `releaseVerdict` (one of GO, GO_WITH_CONDITIONS, NOT_READY, INSUFFICIENT_EVIDENCE) and `verdictVersion` (the versioned verdict-module identifier from Phase 4).
9. **New frozen key set** (sorted): `grade`, `modelVersion`, `releaseVerdict`, `resolvedFindings`, `scannedAt`, `scope`, `verdictVersion`.
10. Update the regression test in `score-service.test.ts` deliberately and in the same commit. Keep the existing negative assertions (`not.toHaveProperty("targetUrl")`, `not.toHaveProperty("breakdown")`) and add new ones asserting absence of: blocker counts, per-severity counts, issue titles, control-level detail, repo identity, and environment names. The test's job is to make the next accidental disclosure loud.
11. The verdict is **frozen into `publicPayload` at share creation**, like every other field. A later run does not silently change a published verdict; the existing supersession notice must state that a newer scan exists.
12. Copy: the public card must carry the scope qualifier and the existing "not a security guarantee" language. A NOT_READY verdict is publishable only because sharing is opt-in and user-initiated — do not add any flow that publishes a verdict automatically.
13. Sharing stays gated on `ScoreSnapshot.shareEligible`, remains role-restricted, audit-logged and revocable. Do not relax the eligibility gate to increase share volume.
14. Update `/score/methodology` to document how the verdict is computed, since the scoring methodology is fully public per founder decision #1.

### Acceptance criteria

- Completed eligible runs create or update a trust record without user action.
- Users can read current scope and freshness, including what was not evaluated.
- Public records expose only the seven allowlisted keys, asserted by the updated regression test.
- Revoked links stop working immediately.
- A published verdict does not mutate when a newer run completes; supersession is shown instead.
- The methodology page explains the verdict before the verdict ships publicly.

## 9. Phase 8, 9 and 10 — Notifications, Sharing, Landing

## Phase 8 — Notifications (in-app and email; push deferred)

**Goal:** the five default events reach the user reliably, with per-event channel control and zero sensitive content in transit.

**Branch:** `feat/uxv2-p8-notifications`

### Starting point

The `Notification` model already exists (workspaceId, userId, channel, type, title, body, status pending/sent/read/failed, sentAt, metadata) with `packages/db/src/notification-service.ts` exposing create, list, mark-sent, mark-read and a `createAndSendNotification` fan-out that takes a `sendFn` callback. `DEFAULT_CHANNELS` is currently in_app, slack, discord — email is the column default but is not in that constant, which is the first thing to fix. Brevo credentials exist in `.env.example` (`BREVO_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_FROM_EMAIL`). There is no `NotificationPreference` model.

### Tasks

1. **New table `NotificationPreference`** — the second and last permitted schema addition. Shape: `userId`, `workspaceId`, `eventType`, `inApp Boolean`, `email Boolean`, unique on (userId, workspaceId, eventType). Carry `workspaceId` directly so the existing workspace-scoped RLS pattern applies unchanged.
2. Default-on events: run completed, approval required, verified critical or high issue, retest completed, verdict changed. Default-off: weekly summary, evidence becoming stale, new dependency risk, integration failure, team activity.
3. Fix `DEFAULT_CHANNELS` to include email, and make channel resolution read preferences rather than a constant.
4. In-app notification centre: bell in the mobile page header and the desktop header, unread counter, full list under More on mobile and at `/dashboard/notifications` on desktop. Mark-read on open.
5. Notification objects carry: event type, product, urgency, short explanation, timestamp, primary action deep link, read state, delivery-state metadata. Deep links must open the specific product, run, issue or approval.
6. **Email templates.** Completion email shows product, verdict, duration and coarse counts only. **No finding titles, no severity detail beyond counts, no file paths, no repo names, no evidence content, no cost.** Every email ends by sending the reader into an authenticated view for detail. Add a test asserting a rendered email body contains none of a fixture finding's identifying strings.
7. Delivery retries with backoff, and `status` transitions recorded so a failed send is visible rather than silent.
8. Notification preference centre in Settings, per event and per channel.
9. **Web push deferred (decision 6).** Do not add VAPID keys, a service worker, or a permission prompt in this phase. Leave a preference row shape that can accommodate a `push Boolean` later without a migration rewrite. When push does land, the permission prompt must appear only after an explicit in-product opt-in, must handle denied and dismissed states without re-prompting, and must degrade silently on unsupported browsers.
10. The notification opt-in prompt lives on the **active-run screen** (decision 5), phrased around the wait the user is already in.

### Acceptance criteria

- All five default events deliver in-app and by email.
- Per-event channel control works and persists.
- No browser permission prompt exists anywhere in this phase.
- Deep links land on the correct resource.
- Emails contain no sensitive evidence, asserted by test.
- A failing send is retried and observable.

---

## Phase 9 — Sharing and virality (extension of an existing system)

**Goal:** more shareable artefacts and a real composer — built on the share machinery that already ships.

**Branch:** `feat/uxv2-p9-sharing`

### Scope correction

This phase is much smaller than the strategy implies. Already built: `ScorecardShare` with slug, frozen `publicPayload`, `revokedAt` and an advisory lock enforcing one active share per snapshot; `ScorecardEvent` with dedup on shareId+eventType+channel+visitorHash+dayBucket; `ReferralCode` and `ReferralAttribution` with new-account gating and idempotent dual-sided rewards; `/score/[slug]`, `/score/methodology`, `/api/og`, `/api/badge`. **Do not build a parallel share schema.**

### Tasks

1. Share composer with live preview showing exactly what becomes public. Toggles may only ever narrow disclosure, never widen it beyond the frozen allowlist.
2. **Two new card variants: trust milestone and resolved issue.** Each is a new public payload shape and therefore needs **its own dedicated allowlist constructor** in `score-service.ts` (or a sibling with the same discipline) **and its own regression test asserting an exact key set**. Copy the `buildScorecardPayload` pattern; never route a new variant through a generic serializer.
   - Trust milestone: controls evaluated, issues resolved, current scoped verdict/grade, methodology version, timestamp. No repo name, no issue titles.
   - Resolved issue: a category label only (never the issue title), the detected-to-fixed-to-retest-confirmed state chain, and the retest timestamp. Must require `FindingVerificationStatus = VERIFIED` plus a retest-confirmed receipt — a merely DETECTED issue can never produce a "resolved" card.
3. Image ratios 1200x630, 1080x1080, 1080x1350, 1080x1920 via the existing OG endpoint.
4. Channels: native share sheet, X, LinkedIn, Reddit, WhatsApp, email, copy link, save image. Native share via the Web Share API with a copy-link fallback.
5. README badge states: evidence current, review in progress, evidence stale — served by the existing `/api/badge`.
6. Prompts: after the first completed review, and after a retest-confirmed fix. Never nag, never auto-post.
7. Referral attribution reuses the existing privacy-safe identifiers. Analytics stay coarse and allowlisted: social renders never count as human views, and no target, repo, finding, IP, user-agent or caption data may enter analytics.

### Acceptance criteria

- The preview shows exactly the published payload, byte for byte.
- Every public object is revocable and revocation is immediate.
- Private repository data is excluded by construction, not by configuration.
- Each new variant has its own passing exact-key-set test.
- A resolved-issue card cannot be produced without a retest-confirmed verification receipt.
- Images render correctly at all four ratios.

---

## Phase 10 — Landing page

**Goal:** the commercial promise lands in the first viewport without breaking the evidence guardrails.

**Branch:** `feat/uxv2-p10-landing`

### Starting point

`apps/marketing/src/pages/index.astro` orders: PremiumHero, HomeLiteScan, how-it-works anchor, EvidenceWorld, AssuranceRecord, TwoDepths, FreeToolsPreview, WhereYouWork, Faq, FinalCta. Current H1 is "Know what was tested before you ship." with primary CTA "Run a free Lite Check". PostHog fires `landing_view`, `cta_click`, `faq_open`.

### Tasks

1. Rewrite the hero toward the release-decision promise while keeping it truthful. Primary CTA becomes Connect GitHub; Lite Check stays as the strong secondary — it is the working top-of-funnel and must not be demoted out of the first viewport.
2. Hero visual: an autonomous-activity animation showing mapped, evaluated, verified, preparing, awaiting approval. It must be visibly illustrative, use a fictional product name, and respect `prefers-reduced-motion` (the pattern already exists in `PremiumHero.astro` and `Base.astro`).
3. Add sections for Guided Autonomy, connect-once product discovery, audience-specific use cases, and a public trust-record demo linking to a real `/score/[slug]`.
4. Preserve the existing Lite Check funnel handoff (`sessionStorage` into `/scan?start=1`) and the `PUBLIC_SCANNER_URL` disabled state.
5. Add `data-cta-id` attributes to every new CTA so the existing `cta_click` instrumentation captures them with no new event types.
6. **Deploy gotcha:** per the recorded `@astrojs/cloudflare` v14 split-brain, `PUBLIC_SITE_URL` and `PUBLIC_INDEXABLE` must be set in `wrangler.jsonc` `vars` per environment, not only in CI shell env — otherwise canonicals and sitemap URLs diverge. Do not regress the `astro.config.mjs` fallback that reads `wrangler.jsonc`.
7. Mobile performance: keep LCP and CLS within the existing budget; the hero animation must not become the LCP element.

### Acceptance criteria

- The promise is understandable in the first viewport at 390px.
- Connect GitHub is primary; Lite Check remains available above the fold.
- No claim exceeds what `product.md` permits — no uniqueness, benchmark, accuracy, pricing or customer-proof claims, and no reference to the upstream engine.
- LCP and CLS within budget on emulated slow 4G.
- Copy approved by the marketing agent and the founder before merge.

## 10. Engine PR, Analytics Dictionary, Rollout Gates

## 16. Engine PR — run.json hardening (approved, non-blocking)

**Repo:** `ecryptoguru/lyrashield-engine`. **Branch:** `feat/run-json-progress-hardening`. Coordinate with the token-cap and configurable-compaction plan (doc `cms0j0hjm0ou307adaeguchdg`) and ship in the same window.

Rescoped after verification: because `strix/report/state.py` already calls `save_run_data()` on every SDK usage event and every finding, the web app gets a live work signal today. This PR is hardening, not new telemetry, and Phase 5 does not wait on it.

### Tasks

1. **Verify first:** determine whether `_save_artifacts()` already writes atomically. If it does, task 2 is a no-op — record that finding and move on.
2. **Atomic write.** `run.json` is rewritten wholesale, so a reader can observe a torn file. Write to a temp path in the same directory and `os.replace()` into position.
3. **Explicit phase label.** Add a coarse `phase` string to the run record so the consumer is not inferring phase from a usage ledger. Keep the vocabulary coarse and stable — it becomes a consumed contract.
4. **Turn or step counter** alongside `llm_usage`, giving a second monotonic progress signal independent of token accounting.
5. **Monotonic `seq`** incremented on every save, so the worker can detect staleness and the web ETag can key off it.
6. **No new egress, no new env vars, no Redis.** The engine must remain unable to reach the queue. Do not touch the `buildEngineEnv` allowlist on the web side.
7. Keep the payload free of anything the worker is not permitted to forward — no file paths beyond what already exists, no target identity in the progress fields.
8. Tests: torn-read resistance (write a large file while reading in a loop), `seq` monotonicity, and phase-label stability across a full run.

`event_sink` in `strix/core/runner.py` (`StreamEventSink = Callable[[str, Any], None]`) currently has no non-TUI implementation. Do **not** build one for this purpose — it carries raw SDK stream events including tool calls and arguments, which is exactly the data that must not cross the boundary. The run-record path is the correct, narrower channel.

---

## 17. Analytics event dictionary

All events go through the typed `track()` wrapper from Phase 0. Property allowlists are enforced by construction. Reuse the marketing PostHog privacy configuration.

### Activation funnel

| Event                      | Allowed properties                                       |
| -------------------------- | -------------------------------------------------------- |
| `landing_view`             | utm_source, utm_medium, utm_campaign, referrer_host      |
| `signup_started`           | method                                                   |
| `account_created`          | method                                                   |
| `github_connect_started`   | —                                                        |
| `github_connected`         | repo_count_bucket, account_type                          |
| `repos_loaded`             | repo_count_bucket, load_ms_bucket                        |
| `repos_selected`           | selected_count                                           |
| `product_confirmed`        | asset_count, suggested_assets_declined                   |
| `trust_plan_accepted`      | plan_preset, customised (bool)                           |
| `first_run_started`        | preset, asset_count, estimate_low_min, estimate_high_min |
| `first_run_completed`      | preset, duration_bucket, verdict, outcome                |
| `first_issue_viewed`       | verification_status                                      |
| `first_remediation_action` | action_type                                              |
| `first_retest`             | outcome                                                  |
| `first_evidence_share`     | variant, channel                                         |
| `paid_conversion`          | **deferred — billing not implemented**                   |

### Engagement

`run_started`, `run_completed`, `approval_requested`, `approval_decided` (decision), `issue_status_changed` (from_status, to_status), `evidence_refreshed`, `share_created` (variant, channel), `share_revoked`, `notification_opened` (event_type), `weekly_return`.

### Forbidden properties — globally, on every event

Repository name or full name, owner login, target URL, branch name, file path, finding title, CWE, severity, issue count, evidence content, caption text, IP address, user-agent, cost, spend, token counts, cap values. Buckets and counts only. The Phase 0 unit test asserts these are dropped if passed.

---

## 18. Rollout gates and verification

### Per-phase verification (all must be green before PR review)

1. Typecheck, lint, unit tests and build, using the scripts declared in the root `package.json` and `turbo.json` — read them rather than guessing names.
2. Playwright at 390x844, 768x1024 and 1280x800, including the visual-regression suite.
3. The legacy-route redirect assertion.
4. A manual one-handed mobile pass through the phase's primary flow.
5. For any phase touching a security-critical zone from section 3: an explicit note in the PR description naming the zone, what changed, and why it is safe.

### Rollout stages

| Stage                 | Audience                      | Flag                      | Gate to advance                                                                                                                                                                |
| --------------------- | ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Internal preview   | Founder plus selected testers | `UX_V2_INTERNAL_USER_IDS` | Navigation, onboarding, grouping, run creation and mobile responsiveness all exercised without a blocker                                                                       |
| 2. New-account beta   | Newly registered users        | `UX_V2_NEW_USERS_FROM`    | **Activation funnel instrumented and reporting** — Stage 2 exists to measure, so unmeasured is a hard fail. Plus error rate at or below the legacy baseline                    |
| 3. Opt-in migration   | Existing users, banner offer  | Per-workspace override    | Temporary fallback to the legacy interface works from every V2 screen                                                                                                          |
| 4. Default experience | Everyone                      | Flag default true         | Parity check, stable activation, notification delivery reliability, share-privacy review, accessibility review, no critical regression. **Web push may ship here, not before** |
| 5. Legacy removal     | —                             | Flags deleted             | Route compatibility, exported-data compatibility, documentation updated, analytics comparison complete, final regression pass                                                  |

### Non-negotiable acceptance standards (apply at every stage)

- **Mobile:** the full first-review flow completes at 390px; no horizontal scrolling; sticky primary actions; native back-navigation works; accessible bottom navigation; responsive sheets; correct safe-area spacing.
- **Accessibility:** keyboard access throughout, visible focus, reduced-motion respected, screen-reader announcements for dynamic updates, no status conveyed by colour alone, descriptive labels. The existing skip link, reduced-motion block and live scan-completion announcements must be preserved, and the app must gain the skip link it currently lacks.
- **Performance:** lightweight mobile navigation, lazy-loaded technical detail, minimal client JS, server rendering preserved, safe repository-metadata caching, no polling of inactive views, responsive image formats, verified on slow 4G.
- **Security and privacy:** no repository data in public analytics, no finding detail in notifications, allowlisted public-share payloads only, revocable sharing, audit logs for approvals, no client-generated privileged patches, no intrusive action without explicit authorisation.

### Recommended first executable step

Start Phase 0 on branch `feat/uxv2-p0-baseline`. It is the only phase with no user-visible surface, and Phases 1 through 10 are unverifiable without its flags, analytics wrapper and visual-regression baselines. Do not begin Phase 1 until Phase 0's baseline screenshots are committed, because the radius change in Phase 1 is only reviewable as a diff against them.
