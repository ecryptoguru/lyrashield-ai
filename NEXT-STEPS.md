# LyraShield — Next Steps & Action Plan

> **Generated:** 2026-07-03
> **Sources:** Notion workspace (8 pages), local docs (PRD.md, codebase.md, product.md), GitHub repo state (commit `2a55706`)

---

## 🔄 2026-07-11 Thin-Fork Release-Gate Handoff

- **Baseline and adapter:** Engine baseline is `7b639505fecf20a2d9e356f96bd91470aa828182`. The adapter maps product `LYRASHIELD_*` variables only when their `STRIX_*` counterparts are absent; upstream values win and telemetry defaults off. The worker reads both `strix_runs` and `lyrashield_runs` output directories, preserving `0`/`2`/error lifecycle semantics.
- **Automation:** Local engine commit `909493f` adds a Monday 03:23 UTC/manual, PR-only sync workflow. It uses the ancestry gate, exits `20` before rebasing rewritten upstream history, verifies before creating `automation/upstream-<short-sha>`, and has no auto-merge, force-push, or conflict resolver. There is no engine `origin` remote, so it was not published, dispatched, or used to create a PR.
- **Evidence:** Engine frozen verification passed (155 tests, Ruff, formatting, headless mypy over 61 source files, Bandit). App lint, typecheck, build, and 600-test/47-file suite pass. `git diff --check` passes.
- **Release blockers, do not paper over:** The current worker Docker build fails before image creation because Docker's root build includes the unrelated uncommitted marketing workspace and its Cloudflare `workerd` Linux binary is absent. Do not claim an image digest, `lyrashield --version` container smoke, missing-model container proof, or sandbox run from this attempt. Production still needs a pinned sandbox image digest. `LYRASHIELD_LLM` and `LLM_API_KEY` are both absent, so no controlled scan may use a substitute target; after the image gate is restored, missing LLM configuration remains the only controlled-scan blocker.

---

## 🔄 2026-07-04 Update

- **Repo renamed** → `github.com/ecryptoguru/lyrasec-ai` (was `lyrashieldai`). In-code `@lyrashield/*` scopes + `LYRASHIELD_*` env vars intentionally NOT renamed yet (trademark clearance open). *Decision #2 (keep "Lyra-" prefix): trending KEEP — new name retains it; formal trademark clearance (#3) still pending.*
- **Decision #15 (v1 coverage) — RESOLVED:** v1 = agentic pentest **+ SCA + secrets** + GitHub Action/reusable workflow (diff-aware gate) + SARIF. (See PRD §B13.4 / §B8 / §18.)
- **Deep audit completed** (repo @ `396ca63`) → full prioritized backlog embedded in **PRD PART B §B13** (PRD is the single source of truth). **Batch 1 (P0/P1 security/correctness) shipped as PRs #7–#11** (branches; not merged):
  - A0 tenant-isolation: AsyncLocalStorage rewrite + corrected model sets (found a latent crash: soft-delete set wrongly included 4 columnless models → `getWorkspaceMembership` would throw on a real DB) + auth-guard auto-activation + tests. RLS = follow-up (needs DB validation).
  - A1 Redis/Upstash rate-limit (prod limiting was silently no-op); A2/A4 webhook idempotency + exact repo match; A3 onboarding IDOR; A5 GitHub install-URL slug.
  - A7 CI-runs-tests: **blocked** on granting the GitHub App `Workflows: write`.
- **Still open:** domain (#1); Batches 2–4 of the audit. **Done:** Batch 2 (server-fetched initialData + React cache() (B1/B2) ✅, pagination (A6) ✅, API/fetch helpers (B4) ✅, nav-404 stubs (A8 remainder) ✅, shared component library (B3) ✅, frontend a11y + mobile sidebar + dark mode fixes (A8 partial) ✅, premium UI upgrade across all pages ✅). **Batch 3 done:** audit-log hash-chain (A9) ✅, Evidence encryption enforcement ✅, cost/determinism + SARIF 2.1.0 + dual CVSS fields (B5/B6) ✅, Postgres RLS + validate on CI Postgres ✅. **Round-2 handoff done:** migration drift reconciled ✅, CI hardened ✅, supply-chain hardened ✅, nonce-based CSP in `proxy.ts` ✅. **R-G/R-I/R-E quick wins done:** turbo.json globalEnv (8→35) ✅, seed.ts prod guard ✅, .gitignore secrets ✅, scoping.ts docstring ✅, globals.css a11y ✅, env.ts PEM validation ✅, auth cookie hardening ✅, docker-compose localhost binding + limits ✅, deployment doc security (non-root worker, SSH, TLS, backup/restore) ✅, dashboard layout Promise.all ✅. **Sprint 4 done:** BullMQ scan queue, preflight checks, engine runner (child process), output parser, finding persister, scan lifecycle state machine, scan API routes (POST/GET/GET-by-id/POST-cancel), scan detail UI with client-side polling, 396 tests (26 files). **Review fixes done:** evidence encryption (encrypted:// URI), worker workspace context wrapping, `scan.view` permission for read-only roles, `ScanJobData` deduplication in `@lyrashield/types`, CSP removed from request headers, Dockerfile runner stage cleanup, scan detail client-side polling, batch finding persister queries, 26 new tests. **Batch 4 done (2026-07-06):** fix proposals + GitHub PR creation (DB service, API routes, UI), retests (DB service, API routes), reports (HTML generation with 500-finding limit + truncation notice, download, share tokens), notifications (email/Slack/Discord/in-app channels with 10s timeouts, `createAndSendNotification` shared helper, worker notification functions, API routes, UI), schedules (CRON-based scan scheduling, DB service, API routes, UI, `Schedule_targetId_fkey` migration), plain-language findings (CWE explanations + category labels + technicalDetail wiring), permissions extended for all new features (MEMBER restricted from `notification.manage`/`schedule.delete`), 10 code review fixes (P1×2: missing FK migration + invisible worker notifications; P2×4: transaction bypass, permissive permissions, HTTP timeouts, report finding limit; P3×4: explainFinding params, `as never` casts, notification helper dedup, dead cleanup effect). 565 tests, 44 files, all green. **Remaining:** Batch 4 continuation: ~~SCA + secrets scanning~~ ✅ Done (Sprint 6.5), AI-builder-aware URL scan, launch-readiness gate, shareable report/badge, MCP server + prompt-injection defense, GitHub Action diff-gate. **Sprint 5 done (2026-07-06):** Engine MVP — external `lyrashield-engine` binary already wired via `runner.ts` + `command-builder.ts`. **Sprint 6 done (2026-07-06):** Findings normalization — `normalizer.ts` with severity normalization (CRITICAL/HIGH/MEDIUM/LOW/INFO), CWE enrichment (40+ CWE mappings with OWASP categories), CVSS v3.1 score estimation, confidence scoring (0-100), false-positive risk assessment (high/medium/low), cross-source deduplication, finding statistics aggregation. 14 tests. **Sprint 6.5 done (2026-07-06):** SCA + secrets scanning — `sca-scanner.ts` (7 dep file formats, OSV API, CVE extraction, dedup, injectable `fetchFn`, 5 tests), `secrets-scanner.ts` (12 secret patterns, repo walking, redaction, false-positive filtering, 12 tests), `scanner-orchestrator.ts` (parallel scan, normalize, merge, 5 tests), `run-scan.job.ts` + `finding-persister.ts` updated. **653 tests (52 files).** See `codebase.md` §23.

### Round-2 audit + hardening (2026-07-04, MERGED to main)

- Batch 1 (PRs #7–#12) and the CI test step (#14) are **merged to main** (not just branches). A second audit pass over current main → findings in **PRD §B13.7**. Merged round-2: web security headers (next.config), logger secret redaction, GitHub token caching/retry/pagination, auth multi-origin `trustedOrigins` (`ADDITIONAL_TRUSTED_ORIGINS`), Dependabot config.
- 🔴 ~~**Migration drift found (latent P0 on deploy):** only 2 Prisma migrations exist; `schema.prisma` is far ahead~~ **✅ RESOLVED 2026-07-05** — reconciling migration `20260705095000_batch3_missing_tables_columns` creates all missing tables/columns/indexes/constraints. CI drift check (`prisma migrate diff --exit-code`) added.
- **Codex handoff (needs live DB / `Workflows` scope / lockfile regen):** ✅ **ALL DONE 2026-07-05** — (1) migration-drift reconciliation via reconciling migration + R-C additions ✅; (2) CI hardening (least-priv `permissions`, SCA + secret-scan, migration-drift check, build cache) ✅; (3) `eslint-plugin-security` + pin `better-auth`/Prisma exact + refresh `pnpm-lock.yaml` ✅; (4) nonce-based CSP in `proxy.ts` (renamed from `middleware.ts` per Next.js 16) with `connect-src`, `blob:` in `img-src`, `ws:` in dev, 14 CSP tests ✅. See `codebase.md` §20.
- **Note:** §5/§9 below are historical (pre-Batch-1) — PRD §B13 is the authoritative current status.

---

## 1. Notion Workspace Summary

8 pages found in the LyraSec Notion workspace:

| Page | Purpose | Key content |
|------|---------|-------------|
| **LyraSec Operating System** | Hub page | Links to all other pages, open decisions summary |
| **Agent Grounding Brief** | Product facts source of truth | ICP, positioning guardrails, 19 founder decisions, pricing status, GTM phase |
| **Brand & Content System** | Marketing operating system | Voice, naming rules, positioning guardrails, content pillars, channel map, visual rules |
| **Fleet Operations & Autonomy** | Agent fleet architecture | Two-product separation (Lyrafin vs LyraShield), QA pipeline, 30-day autonomy policy, model posture |
| **Landing Page + Waitlist Brief** | Dev-ready implementation spec | Exact copy (7 blocks), layout, waitlist API spec, analytics events, SEO/meta, acceptance criteria |
| **Engineering & GTM Research** | 97KB research base (PART I + II) | Engine analysis, competitive landscape, schema review, threat model, cost controls, pricing, GTM, SEO, 19 founder decisions |
| **Content Calendar** | Content tracking | Fleet status, autonomy clock, planned/published log (nothing published yet) |
| **Documentation Source Index** | Source index | Canonical source mapping, migration status, stale/deprecated tracking |

---

## 2. Local Doc Updates Made

### codebase.md — Sprint numbering fixed

**Before**: Sprint 3 = "Scan Queue", Sprint 4 = "LyraShield Scan Engine" (drifted)
**After**: Sprint 3 = "GitHub App Integration", Sprint 4 = "Scan Orchestrator and Queue", Sprint 5 = "LyraShield Scan Engine MVP" (matches PRD canonical map)

This resolves the doc drift flagged in PRD PART B §B0.

---

## 3. Gaps Between Notion and Local Docs

### 3.1 Already synced (Notion research → local docs)

The 2026-07 commit `f230046` already synced most Notion research into local docs:

- **PRD.md PART B** (B0-B12) covers: engineering research, SSRF/RBAC fixes, schema retrofits, sandbox hardening, verification layer, MCP OAuth 2.1, SARIF/CVSS/OWASP, SCA/secrets, LLM cost controls, fork strategy, revised roadmap
- **product.md** 2026-07 update covers: honest positioning, competitive framing, 5-audience messaging, pricing proposal, GTM plan, SEO clusters, founder decisions

### 3.2 Not yet in local docs

| Item | In Notion | In local docs | Action needed |
|------|-----------|---------------|---------------|
| 19 founder decisions (detailed) | Agent Grounding Brief §18 | product.md mentions them | Add to NEXT-STEPS.md (below) |
| Landing page dev-ready brief | Full spec with exact copy | Not in repo | Implement as Sprint 2.5 or parallel track |
| Fleet operations & autonomy | Full page | Not in repo | Reference only — marketing agent concern |
| Brand & content system | Full page | Not in repo | Reference only — marketing agent concern |
| Content calendar | Full page | Not in repo | Reference only — marketing agent concern |
| Positioning guardrails (hard rules) | Brand & Content System §4 | product.md update layer mentions | Add to product.md original section as warnings |

### 3.3 product.md original section still has aggressive claims

The 2026-07 update layer at the top of product.md corrects the positioning, but the original section below it (Section 3: USPs) still implies "only we verify" and "only we have MCP." The update layer is marked authoritative, but the original should be flagged.

---

## 4. 19 Open Founder Decisions (from Notion)

These block downstream work. Status as of 2026-07-02 — all PENDING.

### Brand & Identity

| # | Decision | Blocks | Status |
|---|----------|--------|--------|
| 1 | **Public domain** — `lyrashield.ai` / `.com` / `.io` / other? | Canonical URLs, SEO, email, landing page | PENDING |
| 2 | **"Lyra-" prefix** — keep (shares prefix with Lyrafin AI) or rename? | All brand work, trademark filing | PENDING |
| 3 | **Trademark clearance** — US/EU/India Class 9 & 42 | Any public use of the name | PENDING |
| 4 | **Product personas** — reuse Lyra/Myra? New ones (Shield/Aegis)? None? | In-product copy, docs | PENDING |

### Pricing & Packaging

| # | Decision | Blocks | Status |
|---|----------|--------|--------|
| 5 | **Tier structure & prices** — confirm $29/$99/$299/$599 + INR equivalents | Pricing page, paywall, Polar/Razorpay | PENDING |
| 6 | **"Agent minutes" as metered spine** — confirm metric + per-tier allowances | Metering implementation, upgrade triggers | PENDING |
| 7 | **Free-tier policy** — 1 target, diff-only, ~30 agent min, email-verified, NO deep scans | Free-tier launch | PENDING |
| 8 | **India pricing** — confirm INR equivalents | Razorpay product setup | PENDING |

### GTM & Launch

| # | Decision | Blocks | Status |
|---|----------|--------|--------|
| 9 | **Design-partner program** — go/no-go? 3-5 partners, 3-9 months | Entire pre-launch validation phase | PENDING |
| 10 | **Build-in-public on X** — founder-led or product-account-led? | Pre-launch content | PENDING |
| 11 | **Launch timing** — target date? Must be production-grade + partners converted | Launch sequencing | PENDING |
| 12 | **HN / Product Hunt** — founder-authored? | Launch-day plan | PENDING |

### Product & Positioning

| # | Decision | Blocks | Status |
|---|----------|--------|--------|
| 13 | **"Two depths, one loop" as headline moat** — confirm or different angle? | All messaging, landing page, comparisons | PENDING |
| 14 | **5 explanation modes** — confirm set? Is "auditor" a mode or a report export? | Messaging by audience, product copy | PENDING |
| 15 | **v1 coverage scope** — agentic-only or SCA + secrets alongside? | v1 landing page feature list, demo | ✅ RESOLVED 2026-07-04 — SCA + secrets ship in v1 (+ GitHub Action/SARIF) |
| 16 | **No public benchmarks** — confirm we will NOT publish XBEN/accuracy numbers | Comparison pages, launch claims | PENDING |

### Engineering-Marketing Dependencies

| # | Decision | Blocks | Status |
|---|----------|--------|--------|
| 17 | **Landing page** — implement dev-ready brief (once domain decided) | Launch | PENDING (domain blocks) |
| 18 | **Programmatic SEO pages** — vuln-class × stack page generation | Phase-2 SEO scale | PENDING (Phase 2) |
| 19 | **Shareable report hardening** — share-token hashing + revocation | PLG viral loop | PENDING (Sprint 8) |

---

## 5. Current Engineering State (verified from code)

### Done (merged to main, commit `2a55706`)

- Sprint 0: Monorepo foundation (Next.js 16, TS 6, Prisma 7, Better Auth, Tailwind 4)
- Sprint 1: Prisma schema (20+ models), Better Auth (email/password + GitHub/Google OAuth)
- Sprint 2: Dashboard, Projects, Targets, Team management with RBAC (10 roles)
- SSRF hardening: Shared `checkScanUrlSafe()` with DNS resolution, IPv6, CIDR ranges, 83-line test suite
- RBAC enforcement: All mutating routes use `requirePermission()`, type-safe `Permission` union, ADMIN audit/policy gap fixed
- CI green: `noUncheckedIndexedAccess` guards, test files excluded from app typecheck
- Audit logging for all sensitive operations

### Completed since last update

- Sprint 2.5: Onboarding flow (7-step wizard, OnboardingState model, GET/PATCH API)
- Sprint 3: GitHub App integration (JWT, installation tokens, repo listing, webhook signature verification, integrations UI)
- Rate limiting middleware (auth 5/min, API 30/min)
- Tests: 781 passing (62 files) — env, onboarding schemas, GitHub webhook signature, install URL, Prisma extension, SSRF, rate-limit, types, API client helpers, audit hash-chain, RLS helpers, UI components, CSP nonce proxy, scan service state machine, preflight checks, scan job processing, API route handlers, engine runner, command builder, output parser (incl. schema validation), queue, normalizer (incl. golden-file regression), SCA scanner, secrets scanner (incl. redaction), scanner orchestrator (incl. cross-source dedup), URL scanner (incl. SSRF blocking + header case), MCP tools (incl. error handling), prompt-injection guard, fix proposals, retests, reports, notifications, schedules, plain-language findings, agent service token (incl. payload validation), agent registry (incl. approval verification + audit fault isolation), agent approval hash, agent permissions.

### Completed (previously listed as "Not started")

- [x] Deep-review remediation (2026-07-10) — tenant-bound agent/report access, server-persisted active-workspace selection, atomic schedule/scan admission, cancellation-safe worker lifecycle, notification fault isolation, DNS/redirect revalidation, nested SCA manifests, and terminal scan-detail refresh. **597 source tests across 47 files** pass. See `codebase.md` §28. A transport-level egress proxy with DNS pinning remains the connection-time SSRF control.

- [x] Email verification — enabled in `auth.ts` with Brevo integration
- [x] Env/secret startup validation — `@lyrashield/config` with Zod schema
- [x] Postgres RLS + Prisma query extension — RLS on all 18 workspace-scoped tables, `withWorkspaceRLS` helper
- [x] ApiKey/ServiceToken model — in schema + reconciling migration
- [x] Finding dedupe key fix — `@@unique([targetId, dedupeKey])`
- [x] Report shareToken hashing — `shareTokenHash` + `revokedAt`
- [x] UsageRecord idempotency key — `idempotencyKey` field
- [x] Soft-delete standardization — `deletedAt` on all models
- [x] Duplicate-target constraints — `@@unique` on `(workspaceId, repoFullName)` + `(workspaceId, url)`
- [x] Missing composite indexes — `Finding(workspaceId, status, severity)`, `AuditLog(workspaceId, createdAt)`
- [x] Prisma migration drift — reconciling migration + CI drift check
- [x] CI hardening — least-priv permissions, security job, build cache
- [x] Supply-chain hardening — `eslint-plugin-security`, exact version pinning
- [x] Nonce-based CSP — `proxy.ts` with per-request nonce, 14 tests

### Completed (Sprint 5–7 + UI/UX refinement)

- **Sprint 5 (Engine MVP):** External `lyrashield-engine` binary wired via `runner.ts` + `command-builder.ts`. See `codebase.md` §21.
- **Sprint 6 (Findings Normalization):** `normalizer.ts` with severity normalization, CWE enrichment (40+ mappings), CVSS v3.1 estimation, confidence scoring, false-positive risk assessment, cross-source deduplication, finding statistics. 14 tests. See `codebase.md` §23.
- **Sprint 6.5 (SCA + Secrets Scanning):** `sca-scanner.ts` (7 dep file formats, OSV API), `secrets-scanner.ts` (12 secret patterns), `scanner-orchestrator.ts` (parallel scan, normalize, merge). 24 new tests. See `codebase.md` §23.
- **Sprint 7 (Tier 2):** AI-builder-aware URL scanner (10 detectors), launch-readiness UI, shareable report/badge, MCP server with real API calls + stdio transport, prompt-injection defense (27 patterns), GitHub Action diff-gate. 16 new tests. See `codebase.md` §24.
- **UI/UX refinement sweep:** Raw `<label>` → `FormField` component, raw color classes → design tokens, `aria-hidden` on all decorative icons, `tracking-tight` on all headings, `Spinner` in all loading states. See `codebase.md` §25.
- **AI pipeline audit (2026-07-06):** Multi-domain code review + full AI pipeline audit. 7 fixes: (1) HIGH — engine env var prefix allowlist in `runner.ts`; (2) HIGH — schema validation for engine output in `output-parser.ts`; (3) MEDIUM — narrowed false-positive patterns in `normalizer.ts`; (4) MEDIUM — LLM usage tracking in `run-scan.job.ts`; (5) MEDIUM — MCP tool call audit logging in `server.ts`; (6) LOW — `technicalDetail` in CWE-specific path in `plain-language.ts`; (7) LOW — golden-file regression test for normalizer. 36 new tests. See `codebase.md` §26.
- **Docker deployment verified (fresh build 2026-07-06, including Agent Action Layer):** All 5 containers build and run, Dockerfile updated to include `apps/agent` package, all 7 migrations applied (including `agent_approval_layer`), 18 RLS tables confirmed, 18 pages return correct HTTP codes (200/307/404), 13 API endpoints respond correctly (400/401 for unauthenticated/missing params), worker ready with BullMQ, Next.js 16.2.10, 781 tests pass inside container.
- **Agent Action Layer (Sprint 3.5 + 7.6, 2026-07-06):** `AgentApproval` model + `ApprovalStatus` enum in Prisma schema with migration + RLS policy. Agent action types in `@lyrashield/types` (service token, action context, action definition, 6 input schemas, approval schemas). `agent-approval-service.ts` in `@lyrashield/db` (create, get, list, approve, deny, saveResult, expireStale, hashInput, verifyInputHash). `apps/agent` headless package with signed service token (HMAC-SHA256, 5-min TTL), `ActionRegistry` with permission checking + approval gate + audit logging, 6 actions (list-targets, run-scan, get-scan-status, list-findings, get-finding, explain-finding), inlined plain-language bridge, BullMQ scan queue enqueuing via `queue.ts`. Agent permissions (`agent:view`, `agent:act`, `agent:approve`) added to all roles. Approval API routes (GET list, POST approve, POST deny). Deep code review applied: 7 fixes — (P1) approval actionName + inputHash verification, (P1) audit log fault isolation, (P1) scan enqueuing with Redis error handling, (P1) service token payload field validation, (P2) static import of plain-language-bridge, (P2) policy validation + projectId/createdAt in responses, (P2) denyApproval approvedById documentation. 23 new tests (service-token: 8, registry: 11, hash functions: 5, agent permissions: 11). See `codebase.md` §27.
- **781 tests (62 files), all green.**

### Not started

- Billing (Sprint 10+). Security Copilot sidebar (Sprint 5.5). Enterprise features (Sprint 12-19: SAML SSO, SCIM, policy engine, private worker, VPC, BYOK/BYOM). Landing page (blocked by founder domain decision #1).

---

## 6. Prioritized Next Steps

### Tier 0 — Founder decisions needed NOW (blocks everything public)

These are non-code decisions only Ankit can make:

1. **Pick a domain** (#1) — blocks landing page, SEO, email
2. **Decide Lyra- prefix** (#2) — blocks all brand work
3. **Start trademark search** (#3) — blocks public name use
4. **Confirm v1 coverage scope** (#15) — blocks v1 feature list (SCA + secrets recommendation)
5. **Confirm "two depths, one loop" as headline** (#13) — blocks messaging

### Tier 1 — Engineering: fix while schema is data-free (PRD PART B §B1.4, §B4)

These are cheap now, expensive after launch data exists:

1. **Enable email verification** in `auth.ts` (`requireEmailVerification: true`)
2. **Add env/secret startup validation** — Zod schema in `packages/config` that fails fast on boot
3. **Rate limiting** — ✅ Done (`proxy.ts`: auth 5/min, API 30/min)
4. **Postgres RLS + Prisma Client Extension** — inject `workspaceId` scope and `deletedAt IS NULL` on every workspace-scoped query
5. **Fix Finding dedupe key** — change `@@unique([workspaceId, dedupeKey])` → `@@unique([targetId, dedupeKey])`
6. **Add ApiKey/ServiceToken model** — hashed secret, workspace scope, scopes, expiresAt, lastUsedAt, revokedAt
7. **Hash Report.shareToken at rest** + add `revokedAt`
8. **Add UsageRecord.idempotencyKey** — prevent double-billing
9. **Standardize soft-delete** — add `deletedAt` to Project, Scan, etc.
10. **Add duplicate-target guards** — `@@unique([workspaceId, repoFullName])` and partial unique on `[workspaceId, url]`
11. **Add missing composite indexes** — `Finding(workspaceId, status, severity)`, `AuditLog(workspaceId, createdAt)`
12. **License hygiene on engine fork** — LICENSE/NOTICE, mark modified files, trademark-clear name

### Tier 2 — Landing page (parallel track, blocked by domain decision #1)

The Notion **Landing Page + Waitlist Dev-Ready Brief** has exact copy, layout, API spec, and acceptance criteria ready to implement:

1. Create `apps/web/src/app/(marketing)/` route group (or lightweight `apps/marketing`)
2. Implement 7 blocks with exact copy from brief
3. Add `WaitlistSignup` Prisma model (id, email unique, role?, building?, source?, utmSource?, utmMedium?, utmCampaign?, referrer?, createdAt, ipHash?)
4. Add `POST /api/waitlist` — Zod-validated, rate-limited, idempotent, UTM capture
5. Add 6 analytics events (landing_view, waitlist_form_start, waitlist_submit_success, waitlist_submit_error, cta_click, faq_open)
6. Dark-mode developer aesthetic, WCAG AA, Lighthouse Performance >= 90, Accessibility >= 95
7. Domain-agnostic: `NEXT_PUBLIC_SITE_URL` env var, no hardcoded URLs
8. Preview deploy is noindex; branch + PR with screenshots

### Tier 3 — Sprint 2.5: Onboarding Flow — ✅ Complete

1. Post-signup workspace creation flow (7-step wizard: Workspace → Target → Goal → Preflight → Scan → Results → Fix)
2. GitHub App installation wizard (integrations page with connect button + repo picker)
3. First-target setup guide (repo or URL from onboarding wizard)
4. Skip option at every step (sets `skipped: true`, redirects to dashboard)
5. Onboarding redirect in dashboard layout (incomplete → `/onboarding`)

### Tier 4 — Sprint 3: GitHub App Integration — ✅ Complete

1. GitHub App JWT minting (RS256) + installation token fetching
2. OAuth flow for GitHub App installation (GET callback + POST install URL)
3. Webhook handler for PR events (HMAC-SHA256 signature verification, timing-safe)
4. Repo listing via installation token
5. Integrations UI page with GitHub connect + repo picker + target creation
6. PR status check (pending/pass/fail)
7. PR comment with findings summary

### Tier 5 — Sprint 4: Scan Orchestrator and Queue — ✅ Complete

1. ✅ Redis + BullMQ queue setup
2. ✅ Scan job producer (API route → queue)
3. ✅ Scan job consumer (worker service)
4. ✅ Scan status tracking (ScanEvent model)
5. ✅ Live scan timeline via client-side polling
6. ✅ Scan cancellation
7. ✅ Scan retry on failure (BullMQ default 3 attempts)
8. ✅ Worker Docker image includes the locked `lyrashield-engine` CLI via the sibling-repo build context; Docker socket connectivity and `lyrashield --version` verified

### Tier 6 — Sprint 5: LyraShield Scan Engine MVP

1. Engine subprocess invocation (`lyrashield -n --target ...`)
2. Structured JSON findings output (upgrade engine)
3. Exit code mapping (0-9 for different outcomes)
4. Event streaming via stdout JSON lines
5. Policy enforcement hooks (`--policy-file`)
6. Sandbox hardening (gVisor/microVM, not plain Docker)
7. Egress proxy + DNS pinning (durable SSRF defense at fetch time)
8. LLM cost controls (in-loop budget guard, diff-only default, model cascade, prompt caching)

### Tier 7 — Design-partner GTM (parallel, blocked by decisions #9, #10)

1. Identify 3-5 design partner candidates (prioritize agencies)
2. Create outreach material
3. Structured weekly feedback process
4. Hard conversion expectations (30-60% benchmark)
5. Build-in-public X content (founder voice)

---

## 7. Canonical Sprint Map (reconciled)

| Sprint | Name | Status | Source |
|--------|------|--------|--------|
| 0 | Repo Foundation | DONE | codebase.md + PRD |
| 1 | Auth + Prisma Schema | DONE | codebase.md + PRD |
| 2 | Dashboard, Projects, Targets, Team | DONE | codebase.md + PRD |
| 2.5 | Onboarding Flow | DONE | codebase.md + PRD |
| 3 | GitHub App Integration | DONE | codebase.md + PRD |
| 3.5 | Agent Action Layer MVP | DONE | PRD (Agent-Native), codebase.md §27 |
| 4 | Scan Orchestrator and Queue | DONE | codebase.md + PRD |
| 5 | LyraShield Scan Engine MVP | DONE | codebase.md §21 |
| 5.5 | Security Copilot Sidebar | NOT STARTED | PRD (Agent-Native) |
| 6 | Findings Normalization | DONE | codebase.md §23 |
| 6.5 | SCA + Secrets Scanning | DONE | codebase.md §23 |
| 7 | Tier 2 (URL Scan, Launch-Readiness, Shareable Report, MCP Server, Prompt-Injection Defense, GitHub Action) | DONE | codebase.md §24 |
| 7.5 | AI Pipeline Audit (env var allowlist, output validation, FP narrowing, LLM usage tracking, MCP audit logging, technicalDetail fix, golden-file test) | DONE | codebase.md §26 |
| 7.6 | Agent Approval Layer | DONE (deep code review applied) | PRD (Agent-Native), codebase.md §27 |
| 8 | Reports | DONE (Batch 4) | codebase.md §22 |
| 8.5 | Visual Security Plan and Recap | NOT STARTED | PRD (Agent-Native) |
| 9 | Notifications | DONE (Batch 4) | codebase.md §22 |
| 9.5 | MCP Server for Coding Agents | DONE (Sprint 7) | codebase.md §24 |
| 10-19 | Enterprise, Billing, Compliance | NOT STARTED | PRD |

---

## 8. Key Positioning Guardrails (from Notion — must not violate)

These are hard rules from the Brand & Content System. Any public-facing content (including product.md if it goes public) must comply:

1. **NEVER** claim "only we verify findings" — XBOW, RunSybil, Horizon3 do too
2. **NEVER** claim "only we auto-fix" — Pixee, Mobb, Corgea, Snyk do too
3. **NEVER** claim "only we have MCP/IDE integration" — Semgrep, Snyk, Aikido do too
4. **NO** benchmark claims (XBEN etc.), false-positive-rate numbers, coverage-parity claims until measured and founder-approved
5. **Moat = the COMBINATION**: one loop, two depths, agent-native everywhere, complete review package
6. **No pricing numbers** in public content (all pricing is proposed, unconfirmed)
7. **Pre-launch**: no claims that scanning works in production today
8. **Never mention Strix** in public content without founder approval

---

## 9. Immediate Action Items (this week)

### For Ankit (founder)

- [ ] Pick a domain (#1)
- [ ] Decide Lyra- prefix keep/drop (#2)
- [ ] Start trademark search (#3)
- [ ] Confirm v1 coverage: agentic-only or SCA + secrets? (#15)
- [ ] Confirm "two depths, one loop" as headline (#13)
- [ ] Confirm design-partner go/no-go (#9)
- [ ] Confirm no-benchmark-claims policy (#16)

### For engineering (can start now, no founder decisions blocked)

- [x] Enable email verification in `auth.ts` — `requireEmailVerification: true`, Brevo integration, `sendOnSignUp: true`
- [x] Add env/secret startup validation (Zod schema in `packages/config`) — `@lyrashield/config` package with `envSchema`, fails fast on boot
- [x] Add rate limiting to auth endpoints — `proxy.ts` (renamed from `middleware.ts` per Next.js 16) with auth (5/min) + API (30/min) limiters, Upstash Redis in prod, in-memory in dev
- [x] Postgres RLS + Prisma Client Extension for workspace scoping — `packages/db/src/extension.ts` auto-injects `deletedAt: null` + `workspaceId` scope, redirects `delete` → soft-delete
- [x] Fix Finding dedupe key (include `targetId`) — `@@unique([targetId, dedupeKey])`
- [x] Add ApiKey/ServiceToken model to Prisma schema — hashedKey, prefix, scopes, expiresAt, revokedAt, lastUsedAt
- [x] Hash Report.shareToken at rest + add `revokedAt` — `shareTokenHash` + `revokedAt`
- [x] Add UsageRecord.idempotencyKey — `@unique` idempotencyKey field
- [x] Standardize soft-delete across all models — `deletedAt` on all 23 models
- [x] Add duplicate-target constraints — `@@unique([workspaceId, repoFullName])` + `@@unique([workspaceId, url])`
- [x] Add missing composite indexes — `Finding(workspaceId, status, severity)`, `AuditLog(workspaceId, createdAt)`, removed redundant `@@index([slug])`
- [x] License hygiene on engine fork — `engine-NOTICE.md` + `engine-CHANGES.md` templates created

### For landing page (blocked by domain decision #1)

- [ ] Implement landing page from Notion dev-ready brief (once domain is decided)
- [ ] Add WaitlistSignup Prisma model
- [ ] Add POST /api/waitlist endpoint
- [ ] Add analytics events
- [ ] Branch + PR with screenshots
