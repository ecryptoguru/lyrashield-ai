# LyraShield AI — Yellowpaper

**Version 1.0.0 — 2026-09-12**

> The technical specification for LyraShield AI: system architecture, scan pipeline, coverage contracts, evidence integrity, tenancy, and distribution interfaces. Public-safe — provider internals, model identifiers, and operational cost data are deliberately excluded. For product narrative see [`whitepaper.md`](./whitepaper.md); for the short overview see [`litepaper.md`](./litepaper.md).

---

## 1. System architecture

```text
Next.js web/API (app.lyrashieldai.com)
  ├─ Identity + workspace RBAC
  ├─ PostgreSQL + row-level security
  ├─ Billing, licenses, affiliates, reports, MCP/OAuth
  └─ Scan queue (enqueue only)
       └─ Dedicated worker
            ├─ deterministic scanners
            ├─ controlled scan engine for repository targets
            ├─ sandboxed containers
            ├─ private evidence storage
            └─ authenticated egress proxy

Astro/Cloudflare marketing (lyrashieldai.com)
  ├─ public content and browser-local tools
  └─ passive Lite Check origin (scanner.lyrashieldai.com)

Tauri Local/Desktop
  ├─ OS-keychain BYOK credentials
  ├─ local engine + sandbox
  └─ optional authenticated Cloud Sync
```

### 1.1 Web request pipeline

Every request traverses a fixed order: proxy (nonce CSP, client-IP trust, rate limit) → session → workspace membership + permission → schema validation → workspace-scoped data access under RLS → audit event for sensitive mutations → typed envelope `{ success, data | error }`. List endpoints use cursor pagination.

### 1.2 Repository scan pipeline

```text
POST /api/scans
  → admission check (entitlement, concurrency, rate limit)
  → live worker heartbeat check          (fail-closed: no heartbeat, no admission)
  → serialized Scan row creation
  → shared enqueue
  → worker preflight
  → isolated checkout / workspace
  → rules of engagement
  → deterministic scanners + controlled engine subprocess
  → normalize and deduplicate
  → upload evidence (checksum + encryption key reference)
  → persist candidates, receipts, manifest, findings, usage
  → score, notifications, terminal state
  → Launch Gate verdict refresh
```

Only repository targets invoke the external engine. URL/API targets use deterministic, profile-bound scanners. Before execution the worker rebinds every authority-bearing queue field (workspace, target, goal, mode, policy) to the stored scan — schema-valid queue data cannot upgrade routing, budget, or policy.

### 1.3 Scan lifecycle

```text
QUEUED → PREFLIGHT → RUNNING → VERIFYING → COMPLETED
```

Terminal alternatives: `FAILED`, `PARTIAL` (engine stopped with findings preserved — never reported as `COMPLETED`), `CANCELLED`, `TIMED_OUT`, `STOPPED_BUDGET`, `REQUIRES_APPROVAL`. Queue/database orphans fail after a bounded window and are never auto-replayed. After any terminal state the target's gate verdict is refreshed.

### 1.4 URL/API scan pipeline

Target creation performs SSRF validation. At fetch time the hostname is resolved, validated, and pinned at the connection; each redirect hop is revalidated. Profiles bound documents, depth, bytes, concurrency, methods, origin probes, and wall time. API Standard/Deep scans require a validated public HTTPS OpenAPI input.

## 2. Engine boundary and model routing

- The engine runs as a controlled subprocess; product code and upstream code are separated by hard-gated seams. Engine output artifacts and parsed fields are byte-, field-, and count-bounded; raw engine output is never logged or persisted.
- Review profiles route through a single routing authority with protected budget caps; a workspace policy may lower but never raise the selected cap. URL/API scans use no engine and carry zero AI budget.
- Agent-minute wall time is metered on engine-backed work. A repository run is metered only after a scan-bound completed receipt or affirmative provider usage proves model-backed work occurred; deterministic runs and pre-provider failures do not consume agent-minutes.
- Private receipts preserve per-request model, token buckets, cache usage, and reconciled cost. Dashboard and public surfaces expose minutes, never provider spend or model identities.
- Engine CLI exit codes: `0` completed/no findings; `2` completed/findings; other nonzero is runtime/config failure.

## 3. Deterministic coverage contracts

### 3.1 Vibe Security 50 (`vibe-security-50/1.1.0`)

Fifty controls routed through four coverage strategies:

| Strategy          | Count | Controls                                  | Basis                                                          |
| ----------------- | ----: | ----------------------------------------- | -------------------------------------------------------------- |
| Deterministic     |     5 | 3, 27, 29, 37, 45                         | Bounded repeatable observation over repository or response     |
| Hybrid            |    10 | 1, 2, 14, 20, 28, 31, 32, 38, 39, 47      | Deterministic signal finds risk; absence stays inconclusive    |
| Engine-led        |    28 | 4–13, 15–19, 21–26, 30, 33, 40–42, 44, 49 | Require auth, data-flow, live interaction, or business context |
| Evidence-required |     7 | 34, 35, 36, 43, 46, 48, 50                | Need deployment/process/human proof a scan cannot establish    |

Every scan records a `coverage_contract` event and one immutable receipt per control. Result language is honest: `DETECTED`, `NO_FINDING` (never "passed"), `INCONCLUSIVE`, `NOT_APPLICABLE`, `EVIDENCE_REQUIRED`. URL/API scans use the versioned `url-scan/2.0.0` capability registry (six released profiles: Surface, Expanded Surface, Behavioral Surface, Endpoint, Contract, Contract Behavior Review) and show only applicable deterministic receipts.

Execution reuses the engine invocation plus deterministic SCA, secrets, URL, agent-configuration, AI data-exposure, and ML supply-chain phases. CVE-bearing dependency findings may receive bounded, cached enrichment from the CISA KEV catalog and FIRST EPSS; enrichment may fail without failing the scan and never changes severity or verification state.

### 3.2 WebMCP Assurance (`webmcp-assurance/2`, inventory `webmcp-inventory/1`)

Fourteen deterministic controls over browser-registered agent tool surfaces:

| ID        | Title                                                      | Severity |
| --------- | ---------------------------------------------------------- | -------- |
| WEBMCP-01 | Annotation/behavior mismatch                               | HIGH     |
| WEBMCP-02 | External content without untrusted-content hint            | MEDIUM   |
| WEBMCP-03 | Unsafe or dynamic cross-origin exposure                    | HIGH     |
| WEBMCP-04 | Explicitly unsafe permissions or disabled origin isolation | HIGH     |
| WEBMCP-05 | Durable mutation without visible confirmation              | CRITICAL |
| WEBMCP-06 | Sensitive or unbounded input/output contract               | MEDIUM   |
| WEBMCP-07 | Network operation does not forward cancellation            | MEDIUM   |
| WEBMCP-08 | Registration lacks lifecycle cleanup                       | MEDIUM   |
| WEBMCP-09 | Weak schema or missing runtime validation                  | HIGH     |
| WEBMCP-10 | Duplicate, overlapping, or misleading tool contract        | MEDIUM   |
| WEBMCP-11 | Credential or secret embedded in a tool definition         | HIGH     |
| WEBMCP-12 | Prompt-injection surface in a tool contract                | HIGH     |
| WEBMCP-13 | Spec drift or misplaced registration option                | MEDIUM   |
| WEBMCP-14 | Tool contract exceeds browser guidance                     | MEDIUM   |

False-positive guards: an `apiKey` field that is an empty caller-supplied input is not an embedded secret; ordinary imperative documentation is not an injection attempt. Each control yields `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, or `NOT_ASSESSED`; inconclusive is never a clean pass.

Four delivery layers share one analyzer: (1) the shared package — discovery, canonical serialization, deterministic hashing, policy engine, and a safe rewrite planner whose default export is browser-safe; (2) worker scans over the same bounded source collection; (3) the CLI (`check-diff`, `gate`) emitting SARIF and failing builds on `CRITICAL`/`HIGH`; (4) browser surfaces — the public Security Lab (lazy parser worker, source never uploaded) and page-scoped dashboard tools that are read- or prepare-only, capture workspace context from server props, and produce a visible activity receipt per invocation.

### 3.3 AI App Security (AI-01…08)

Eight deterministic signals mapped to the OWASP Top 10 for LLM Applications (2025): prompt-injection input validation, sensitive data in LLM context, AI library supply chain, LLM output in dangerous sinks, unbounded agent permissions, system-prompt exposure, unauthenticated vector DB/RAG access, and missing LLM consumption limits. The browser-local tool runs seven signals with no upload; paid repository scans add advisory dependency enrichment, an optional bounded LLM triage overlay (off by default, additive only), and a private, immutable, versioned score excluded from public scorecards. File selection is mode-capped and records eligible/scanned/skipped counts so incomplete coverage cannot support a clean claim.

### 3.4 AI assurance framework mapping (`ai-assurance-mapping/1.0.0`)

A deterministic readiness mapping — not certification — over OWASP LLM01–LLM10 (2025). Signal states: `OBSERVED` (deterministic signal), `EVIDENCE_ACCEPTED` (accepted operational evidence), `NOT_ASSESSED`, `NOT_APPLICABLE`. NIST AI RMF, MITRE ATLAS, and EU AI Act mappings remain disabled pending recorded owner approval per source version and scope.

### 3.5 Authorized AI safety test pack

A private-beta contract defining a fixed, non-destructive catalog for prompt injection, tool-result injection, system-prompt disclosure, secret disclosure, and unexpected tool calls — scoped to customer-owned non-production HTTPS endpoints under written authorization with exact host, credential, request/duration/response limits, and stop contacts. Destructive tests, browser automation, arbitrary fuzzing, redirects, and model-selected tools are excluded. Raw prompts and responses are excluded from reports, analytics, logs, and model context. It is not a public endpoint scanner or a claim of adversarial robustness.

## 4. Evidence and integrity

- **Manifests.** Every scan persists a result manifest binding execution provenance (product revision, worker image digest, engine revision) into its checksum; workers fail closed before readiness without it.
- **Evidence storage.** All artifacts use a single upload path with checksum and valid encryption-key reference; envelope encryption (AES-256-GCM) in a self-describing format; storage is private, workspace-isolated, and fail-closed. Finding detail never exposes raw storage URIs.
- **Audit chain.** Sensitive mutations create audit rows whose `prevHash`/`hash` serialization is owned by an advisory-locked transaction in the extended data client.
- **Retest binding.** A deterministic retest produces `VALIDATED` only when both the original and retest scans carry stored manifests, exact revisions (which may differ after a fix) or matching URL checksums, and complete deterministic coverage. Missing identity writes an idempotent `INCONCLUSIVE` receipt and never sets `FIXED`. Manifests persist before retest finalization so crash recovery resumes pending retests without replaying billable work.
- **GateVerdict.** Append-only, RLS-protected rows per target; the verdict is a pure versioned function over stored evidence.
- **Signed reports.** Launch Readiness Reports carry a frozen allowlisted payload and an ed25519 signature over its checksum from a server-owned key, publicly verifiable by checksum. Share tokens are 30-day, revocable, expiry-aware.
- **Idempotency.** Webhooks, usage, packs, refunds, commissions, and payouts are idempotent; money uses fixed-precision decimal, never float.

## 5. Tenancy, authorization, and billing ownership

### 5.1 Tenancy

Every workspace query is explicitly scoped by `workspaceId`; request context travels in `AsyncLocalStorage`; a transaction-local context helper applies database RLS. Soft-delete and workspace-scope model sets are closed lists containing only models with the required columns. Child tables are scoped through parents under fail-closed RLS.

### 5.2 Authorization

Role order: `OWNER > ADMIN > SECURITY_ADMIN > APPSEC_MANAGER > BILLING_ADMIN > DEVELOPER > MEMBER > EXTERNAL_PENTESTER > AUDITOR > VIEWER`. Consequential actions require permission plus either exact-input approval (single-use, expiry-aware, bound to action name and input hash) or a browser-confirmed connection grant bound to workflow, target, profile, and idempotency key. Remote OAuth is read-only by default.

Platform administration sits outside workspace roles: a fixed email allowlist, verified `PLATFORM_OPERATOR` accounts, recent TOTP-stamped browser sessions, action-specific single-use elevation nonces, transaction-time authority revalidation, and atomic platform audit rows. Bearer credentials and workspace roles never cross this boundary.

### 5.3 Account-owned billing

Subscriptions, allowances, usage balances, packs, grace, and overage belong to `BillingAccount.accountId` / `UsageRecord.accountId` / `MinutePack.accountId`. `workspaceId` on those rows is purchase attribution only. The sponsoring account is always trusted persisted state — the scan's `createdById`, the schedule's `createdById`, the API key's `createdById`, or the agent connection's `userId` — never a client-supplied payer ID; missing sponsors fail closed. Entitlement decisions evaluate the sponsor account's `effectivePlan`; workspace plan fields are display mirrors. Account-scoped rows are additionally protected by restrictive owner policies layered over workspace RLS.

Annual subscriptions grant a fresh monthly allowance per cycle, computed from the term anchor (month-end clamped, no chained drift) by an idempotent replenishment job — one pool per (account, cycle, plan), no rollover or catch-up stacking.

## 6. Public-surface trust boundaries

### 6.1 Lite Check (scanner.lyrashieldai.com)

Passive, outside-only, no signup:

- GETs the submitted public page, reads response headers, and fetches at most six same-origin JS/CSS assets already linked by that page.
- Detects high-confidence credential patterns without retaining or returning matched values; reviews baseline headers, HTTPS/mixed-content, data-layer markers, and framework fingerprints.
- Never authenticates, exploits, fuzzes, brute-forces, crawls arbitrary paths, or fetches exposed `.env` paths.
- SSRF guard: HTTP(S) only; credentials, query strings, and fragments rejected; private/loopback/link-local/metadata/CGNAT/reserved and mapped IPv6 ranges blocked; ≤3 redirects, each revalidated; 10s timeout; 4 MiB page + six 750 KiB asset caps; same-origin assets only.
- Hashed-IP rate limit; bot verification fails closed; no server-side persistence of target body, asset content, matched secrets, or result.
- Shareable cards carry a signed, allowlisted payload (versions, timestamp, aggregate counts, optional referral code) — `noindex`, `no-referrer`, no target or finding detail.

### 6.2 Browser-local tools and Security Lab

Tool inputs never leave the browser. The WebMCP lab runs heavy parsing in a lazy worker; apply operations update only the local preview. Analytics events exclude scanned URLs, page content, matched values, email, IP, user agent, and finding text; hostnames are hashed client-side; DNT/GPC opt out.

### 6.3 Public scorecards and reports

The public scorecard payload is built by a single allowlisted constructor: grade, scope line, scan date, methodology versions, resolved-findings count, release verdict — never findings, severities, CWEs, target URLs, repository identity, raw IPs, user agents, or captions. View/share events are allowlisted, deduplicated, and privacy-bounded; social renders never count as human views. Revoked or expired shares return 404.

## 7. Local/Desktop architecture

Tauri v2 application (macOS, Windows): compiled Rust core + React frontend.

```text
Signed license verification (Rust, offline-capable)
  → runtime/engine/Docker detection
  → BYOK credential from OS keychain
  → engine subprocess (sandboxed scan)
  → findings in local SQLite
  → optional authenticated Cloud Sync
```

- **License verification.** ed25519 over canonical JSON (lexicographic key sort, no whitespace), byte-identical to the server package and proven by an embedded golden vector. Verification lives in compiled Rust, outside the XSS-attackable webview. `updateEligibleUntil` gates updates; revocation is a hard-stop that overrides perpetual fallback.
- **BYOK.** Subscription sign-in delegated to the engine CLI; API key/endpoint pairs stored in the OS keychain (Keychain / DPAPI / Secret Service), injected only as environment variables at scan launch. No LyraShield model keys exist in the app; engine telemetry is forced off.
- **Offline.** License verifies against a bundled public key with no network; revalidation on reconnect hard-stops on revocation.
- **Updates.** Signed updater manifest; install is gated by license eligibility; users past eligibility keep the last eligible build forever.
- **Network egress.** Only the license API and opt-in sync endpoints are contacted — no telemetry.
- **Sandbox gate.** Scans will not launch without a detected container runtime; there is no bypass mode.
- **Sync contract.** Explicit opt-in; entitlement-checked connect; batched findings upload with cursor management and rewind handling.

Threat model covered: license forgery and tampering (signature over exact payload bytes), webview XSS bypass (verification in Rust), credential theft from disk (OS keychain only), update-channel MITM (signed artifacts), updater-key compromise (documented rotation), unintended egress (license + opt-in sync only), and unsandboxed execution (hard gate).

## 8. Distribution contracts

| Surface                 | Contract                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lyrashield` CLI        | `login/use/doctor/install/init`, scan/finding/report commands, `check-diff`, `gate`; Node 24+                                                                                                                                                                                                 |
| Gate exit codes         | `0` ready/no blocking findings · `1` not ready/blocking findings · `2` error — stable contract                                                                                                                                                                                                |
| `@lyrashield/mcp`       | stdio server + remote Streamable HTTP endpoint with hosted OAuth; read tools by default; delegated writes revalidate membership, permission, scope, expiry, idempotency                                                                                                                       |
| Agent plugin / registry | 30 registry entries resolving 26 preferred client surfaces across config-file, vendor-CLI, guided-manual, and plugin-package install paths                                                                                                                                                    |
| GitHub Action           | Account-less, diff-aware gate on the user's runner; SARIF output; high-confidence WebMCP subset mirrors CLI rule IDs                                                                                                                                                                          |
| Public API `/api/v1`    | Additive-only: no removed fields, renamed paths, changed status semantics, or narrowed request shapes; breaking changes ship as `/api/v2`; ≥90-day deprecation notice with OpenAPI `deprecated: true` and a documented migration path (full policy: [`api-stability.md`](./api-stability.md)) |

## 9. Contract-version registry

| Contract                       | Version                                     | Surface                         |
| ------------------------------ | ------------------------------------------- | ------------------------------- |
| Vibe Security 50               | `vibe-security-50/1.1.0`                    | Full scans, dashboards, reports |
| URL scan capability registry   | `url-scan/2.0.0`                            | WEB_APP/API targets             |
| Launch Gate                    | `lyrashield-gate/1.0.0`                     | Verdicts, reports, CLI, badge   |
| AI-Built Failure Taxonomy      | `ai-built-failure-taxonomy/1.0.0`           | Public read-only endpoint       |
| WebMCP detector / inventory    | `webmcp-assurance/2` / `webmcp-inventory/1` | Lab, scans, CLI, Action         |
| AI assurance framework mapping | `ai-assurance-mapping/1.0.0`                | OWASP LLM readiness mapping     |
| Lite Check payload             | versioned pattern + result contract         | `/scan`, signed cards           |
| Affiliate terms                | `2026-08-18-v1`                             | Partner acceptance record       |

## 10. Technical claims boundary

Deterministic components (policy enforcement, injection guard, RLS scoping) may one day support formal-verification claims; LLM components have no accepted formal adversarial-robustness certification, and none is claimed. A published first-party evaluation of the prompt-injection guard exists (42 OWASP cases, four areas, 85.7% expected-outcome match; a separate observational AILuminate demo run) — it is first-party only and not described as third-party evaluation. Every other claim inherits the whitepaper §9 boundary: no certification, compliance, guarantee, universal detection, or proven robustness.

---

_Specification as of the version date. Executable code, schema, and CI are authoritative where they differ from this document; discrepancies should be treated as documentation bugs. Internal infrastructure identifiers, provider economics, and operational receipts are intentionally excluded._
