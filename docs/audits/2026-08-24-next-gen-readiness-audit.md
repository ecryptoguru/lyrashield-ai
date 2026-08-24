# Next-generation product readiness audit

Date: 2026-08-24  
Scope: LyraShield AI product, agent integrations, public discovery surfaces, dashboard UX, platform administration, and `lyrashield-engine`.

## Executive decision

The two-mode dashboard is the right product shape. It is currently implemented on the **dashboard home** as **Guided** (vibe coders, new developers, and non-technical operators) plus **Pro** (experienced developers, security practitioners, and small teams). Both modes use the same launch-readiness computation; Pro reveals additional risk-posture, finding-mix, remediation-flow, and recent-activity sections. Other dashboard routes do not currently change presentation by mode.

The implementation passed its repository gates and was deployed as product `19bc0b28115efb3e524ef241b7541208f40e6890` in release run `32726286951`. Deployment is **not authorization to provision production administrators or activate billing**. Production administrator provisioning remains a separate controlled operation requiring the exact two verified accounts, enrolled TOTP, the production system database identity, successful preflight, and a fresh TOTP sign-in after all prior sessions are revoked.

## Security and administration

Implemented:

- Exact platform-admin allowlist: `ecryptoguru@gmail.com` and `ankit@lyrashieldai.com`; no aliases, plus-addresses, or third operator.
- Browser-cookie-only global access with verified email, explicit platform role, enrolled TOTP, and a current-session server stamp. Read access expires after 12 hours; writes require a stamp no older than 30 minutes.
- Durable per-user and per-IP challenge limiting, trusted proxy address handling, no trusted-device bypass, and TOTP plus one-time recovery-code sign-in.
- Recovery-code use alerts both administrators in production and creates a global audit receipt; a failed required alert or audit prevents privileged session stamping.
- One-time, action-bound, short-lived mutation elevations. The database rechecks email, role, MFA, live session, expiry, and recent TOTP inside the nonce-consumption transaction.
- Global elevation, limiter, and audit tables are RLS protected and explicitly inaccessible to `app_runtime_prod`.
- Provisioning preflight requires exactly one verified TOTP enrollment record for each approved account. Explicit apply revokes every existing session and elevation for both administrators before creating the bootstrap audit receipt.
- A manual `azure-production` workflow exposes separate preflight/apply modes, exact typed confirmation phrases, migration-state validation, locked dependencies, serialized execution, and the existing privileged database secret. The workflow cannot add a third administrator or bypass verified-email/TOTP prerequisites.
- Read-only overview, user, workspace, scan, affiliate, and global audit views with bounded pagination and minimal fields. No impersonation and no customer secrets or payloads.

Deliberately gated:

- Affiliate mutations return a fail-closed unavailable response. Multi-step financial/payout effects are not enabled until each operation can be atomically receipted and rollback-tested.
- Broad database editors, arbitrary SQL, shell access, secret viewing, impersonation, live billing activation, and deployment buttons are excluded. Those are unsafe substitutes for typed operational workflows.

## Agent, MCP, CLI, plugin, and IDE integration audit

- The canonical CLI is `lyrashield` 0.2.0; the deprecated scoped package is retained only for compatibility.
- The registry records support tier and verification evidence instead of presenting every adapter as native. Native/verified claims require a runtime receipt, tested client/version, and review date.
- All 30 named agent/IDE surfaces remain represented with honest `NATIVE`, `VERIFIED`, `COMPATIBLE`, `EXPERIMENTAL`, or `DEPRECATED` status.
- GitHub Action v2 supports deterministic local `SAFE` and `AGGRESSIVE` gates. `DEEP` is rejected locally and routed to the hosted scan; v1 remains frozen for existing consumers.
- MCP 0.2.2 uses SDK 1.30 metadata, tool titles, schemas, annotations, structured errors, transport cache controls, and compatibility tests for protocol versions `2025-11-25` and `2025-06-18`.
- MCP features not implemented are documented rather than claimed: protocol `2026-07-28`, discovery, durable tasks, TTL/cache-scope metadata, and related experimental headers.

## Dependency and runtime audit

Upgraded and verified: Next.js 16.3.2, BullMQ 6.2.0, React Query 5.102.2, Wrangler 4.125, Vite 8.2.2, Vitest 4.1.11, MCP Zod 4, dotenv 17, eslint-plugin-security 4, and Undici 8.10 through the workspace override.

Retained intentionally:

- ESLint 9 because the current Next.js ecosystem peer range does not yet support ESLint 10 cleanly.
- TypeScript 6.0.3 generally and 5.9.3 for desktop because the active TypeScript-ESLint range requires `<6.1`.
- Node types 24 to match CI/runtime.
- ioredis 5.11.1 until a separate live Upstash TLS and BullMQ acceptance proves the major upgrade.

## SEO, AEO, and GEO audit

- Canonical naming and domain are consistent: LyraShield AI and `lyrashieldai.com`.
- `SeoHead.astro` emits canonical, English and `x-default` alternates, indexability controls, Open Graph, X card metadata, RSS, `llms.txt`, and sitemap discovery. Preview builds fail closed with `noindex, nofollow`; page-level exclusions use `noindex, follow`.
- `astro.config.mjs` requires a public HTTPS origin before enabling indexing, excludes the non-canonical terms route and unavailable scanner route from the sitemap, and emits real content dates rather than build-time freshness.
- `Base.astro` supplies site-wide `Organization` and `WebSite` schema. The homepage adds `WebPage`, `SoftwareApplication`, and visible `FAQPage` entities; articles add `BlogPosting`, author, publisher, image, breadcrumb, publication, modification, word-count, and reading-time data.
- `robots.txt` permits the public surface, publishes the sitemap, explicitly permits GPTBot, ClaudeBot, PerplexityBot, CCBot, and Google-Extended, and blocks every crawler when the build is not indexable.
- `llms.txt` now contains Markdown links rather than bare URLs, a current content date, and a broad crawlable map of 388 product, integration, methodology, and editorial destinations.
- `agents.md` exposes a cacheable machine-readable onboarding contract separately from human integration documentation.
- Copy continues to avoid certification, guaranteed-security, universal-detection, and unsupported verification claims.

Repository verdict: no Critical or High technical discovery blocker was found in the inspected source. This is a code/build verdict, not proof of production crawlability, indexing, rich-result eligibility, Core Web Vitals, or answer-engine citation.

Remaining live proof:

- Re-crawl the deployed origin after release; confirm sitemap/indexation status, canonical tags, structured-data results, and external webmaster submissions.
- Measure branded and non-branded answer-engine citations over time. Repository markup cannot prove that an external answer engine indexed or cited a page.
- Keep claims bound to immutable scan coverage and verification receipts. A content page must not promote an AI candidate into a verified finding.

## UI and accessibility audit

- Guided mode defaults to the next decision, readiness state, launch path, first-run checklist, command center, launch verdict, and two primary metrics. Pro adds three dense sections without changing the underlying evidence state or launch verdict.
- The preference accepts only `guided` or `pro`, defaults safely to Guided, and persists in browser storage under a workspace-specific key. It is not an account-level or cross-device preference.
- The mode control is a labelled button group with `aria-pressed`; navigation, launch actions, and mode-independent evidence remain keyboard-reachable.
- Admin navigation is emitted only after server authorization and each privileged page repeats authorization before starting cross-workspace reads.
- The admin layout is explicitly `noindex`, `nofollow`, `noarchive`, and `noimageindex`; unauthorized access resolves as not found. Read views bound lists and omit customer payloads, source, errors, tokens, model costs, and secrets.
- Sign-in and two-factor pages were rendered at desktop and 390x844 mobile sizes. The tested pages had no horizontal overflow, duplicate IDs, unlabeled inputs, console errors, or broken heading structure.
- TOTP and recovery modes use explicit labels, input modes, autocomplete behavior, disabled/loading states, live error regions, and keyboard-operable buttons.
- Authenticated browser proof now runs against disposable PostgreSQL only. It enrolls real TOTP through the UI, proves admin access is denied before role assignment, signs in through the MFA challenge, visits every admin destination, checks private/no-store API caching, verifies mobile overflow, and fails on browser console errors.

Remaining UI proof:

- Extend Guided/Pro only when research shows route-specific density is needed. The current home-only switch is the smallest coherent implementation and avoids duplicating evidence semantics across the product.
- The deployed admin overview now describes the operation-specific elevation/audit boundary accurately and labels the read-only destination “Review affiliates.” Authenticated production proof still requires a successfully provisioned, freshly TOTP-verified operator session.
- Guided and Pro density should still receive periodic visual-regression review as their underlying dashboard content evolves.
- Run external screen-reader and contrast checks on the deployed revision; the local semantic pass is not equivalent to assistive-technology certification.

## Engine latency and cost audit

`lyrashield-engine` now avoids rewriting unchanged vulnerability, SARIF, executive-summary, and resumable-state artifacts for every usage update. `run.json` and the billing receipt still persist on every relevant update. The artifact-state revision is monotonic and concurrency-safe.

Measured focused benchmark: unchanged-artifact persistence decreased from 117.102 ms to 0.250 ms (about 99.8%). Model routing and scan-budget authority were not changed, so the established Luna/Terra policy remains the source of truth.

## World-class product priorities

1. Finish the current production evidence-storage, actionable-alerting, cancellation/recovery, license-signing, public-scorecard, and independent-finding-verification gates.
2. Add typed admin runbooks one domain at a time. Each mutation needs preview, exact scope, reauthentication, idempotency, atomic audit, rollback, and a focused failure-injection test.
3. Build an integration conformance matrix in CI using pinned client versions and publish only evidence-backed compatibility badges.
4. Add release-policy templates by user outcome (safe demo, public beta, paid launch, regulated data) while preserving a single evidence model.
5. Track time-to-first-evidence, inconclusive-coverage rate, retest completion, false-positive disposition, launch blockers resolved, model cost per completed scan, and queue/cancellation health. Do not expose internal model cost in customer payloads.

## Release evidence

- Production release `32726286951` applied the forward migration set and promoted app `lyrashield-app--0000169`, scanner `lyrashield-scanner--0000150`, and egress proxy `lyrashield-egress-proxy--0000019` at 100% traffic. Public app, scan, scanner, and egress health passed.
- Worker digest `sha256:aeeffe89ec8a490671ca559ae6466a0622df79ba6ded2ffb8211b908e2404f36` runs product `19bc0b28` and engine `944a84f`; the VM launcher hash matches the reviewed repository script and `/api/ready/scans` passed after promotion.
- Production admin preflight `32728732596` failed safely before account reads or mutations because its workflow omitted Prisma generation; PR #413 fixed that. Retries `32729923445` and `32730207675` exposed unrelated application-env loading, also before account reads. Read-only branch preflight `32730440129` then proved the isolated client reached account validation and failed because verified account `ecryptoguru@gmail.com` has not enrolled TOTP. It stopped at the first failure, so `ankit@lyrashieldai.com` remains unevaluated and no account was modified.

- Fresh PostgreSQL 17: all migrations applied; privileged owner access passed; `app_runtime_prod` held no table privileges and direct access was denied.
- Core test suite: 274 files passed, 1 skipped; 2,262 tests passed, 16 skipped.
- Focused combined admin/auth/security batch: 15 files and 85 tests passed; independent final review found no remaining Critical or High findings and approved the controls for conditional provisioning.
- Authenticated Chromium admin flow: 1 passed against a freshly migrated disposable database, including TOTP enrollment and sign-in, authorization denial, all six admin destinations, API cache controls, mobile overflow, and console-error checks.
- Disposable provisioning proof: a missing verified TOTP record failed closed; exact-two preflight and apply passed; the result contained two operators, zero prior sessions, zero prior elevations, and one bootstrap audit.
- Codex Security working-tree review: complete changed-surface coverage and zero reportable findings. The immutable scan identifier and digest belong in the external release receipt so recording them does not alter the tree they identify.
- Monorepo typecheck: 34 tasks passed.
- Monorepo build (11 tasks), lint (32 tasks), typecheck (34 tasks), formatting, production dependency audit, Action lint, migration diff, and `git diff --check` passed.
- Engine suite: 1,300 passed and 1 skipped; focused deduplication tests and Ruff passed. Repository-wide Pyright now reports 0 errors and 0 warnings without excluding pinned Strix modules.
- Focused source-backed SEO/UI re-audit: 5 web test files and 30 tests passed for dashboard mode, navigation, and platform-admin views; all 18 marketing test files and 129 tests passed.
