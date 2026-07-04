# LyraShield — Next Steps & Action Plan

> **Generated:** 2026-07-03
> **Sources:** Notion workspace (8 pages), local docs (PRD.md, codebase.md, product.md), GitHub repo state (commit `2a55706`)

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
| 15 | **v1 coverage scope** — agentic-only or SCA + secrets alongside? (Recommendation: ship SCA + secrets with v1) | v1 landing page feature list, demo | PENDING |
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
- Tests: 115 passing (env, onboarding schemas, GitHub webhook signature, install URL)

### Not started (PRD PART B §B0.1)

- Email verification (currently disabled in `auth.ts`)
- Env/secret startup validation
- Postgres RLS + Prisma query extension
- ApiKey/ServiceToken model
- Finding dedupe key fix (include `targetId`)
- Report shareToken hashing
- UsageRecord idempotency key
- Soft-delete standardization
- Duplicate-target constraints
- Sprint 4+: Scan queue, engine integration, findings pipeline, fix PRs, retest, reports, billing, agent/MCP layer

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
3. **Rate limiting** — ✅ Done (middleware.ts: auth 5/min, API 30/min)
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

### Tier 5 — Sprint 4: Scan Orchestrator and Queue

1. Redis + BullMQ queue setup
2. Scan job producer (API route → queue)
3. Scan job consumer (worker service)
4. Scan status tracking (ScanEvent model)
5. Live scan timeline via SSE or polling
6. Scan cancellation
7. Scan retry on failure
8. Worker Docker image with `lyrashield` CLI installed

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
| 3.5 | Agent Action Layer MVP | NOT STARTED | PRD (Agent-Native) |
| 4 | Scan Orchestrator and Queue | NOT STARTED | PRD (canonical) |
| 5 | LyraShield Scan Engine MVP | NOT STARTED | PRD (canonical) |
| 5.5 | Security Copilot Sidebar | NOT STARTED | PRD (Agent-Native) |
| 6 | Findings Normalization | NOT STARTED | PRD |
| 6.5 | SCA + Secrets Scanning | NOT STARTED | PRD PART B B8 (new) |
| 7 | Fix Proposals | NOT STARTED | PRD |
| 7.5 | Agent Approval Layer | NOT STARTED | PRD (Agent-Native) |
| 8 | Reports | NOT STARTED | PRD |
| 8.5 | Visual Security Plan and Recap | NOT STARTED | PRD (Agent-Native) |
| 9 | Notifications | NOT STARTED | PRD |
| 9.5 | MCP Server for Coding Agents | NOT STARTED | PRD (Agent-Native) |
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
- [x] Add rate limiting to auth endpoints — `middleware.ts` with auth (5/min) + API (30/min) limiters, Upstash Redis in prod, in-memory in dev
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
