# Live AI safety and remote-target ownership — implementation plan

> **Execution:** work on `codex/live-safety-product`; keep release/promotion work isolated on `codex/live-ai-safety-beta`.

## Goal

Make paid remote scans and the live AI safety beta self-service without weakening target authorization. A workspace proves a domain once, keeps a reusable safety contact, optionally supplies a test credential, and an Owner or Security Admin starts an approved test in one final confirmation. Members can prepare a run and request that confirmation.

## Scope and acceptance rules

- Browser-local tools remain anonymous and never require remote-target proof.
- Paid repository scans require an installed workspace-owned GitHub App installation.
- Paid URL/API scans require a current verified domain before the first remote request.
- Live safety tests additionally require a verified domain, a `STAGING`/`PREVIEW` target, a reusable incident contact, an optional credential reference only when sign-in is needed, and an owner/admin confirmation at start time.
- A live test remains bounded, non-destructive, exact-catalog only, redirect-free, SSRF-safe, auditable, and fail-closed.
- DNS TXT is the universal verification path. Google Search Console is an optional convenience path only when a configured OAuth connection with the required read-only scope is available; its absence never blocks a customer.

## Work items

### 1. Reuse and tighten existing contracts

**Files:** `packages/types/src/ai-safety-tests.ts`, corresponding contract tests.

1. Change the plan contract from an opaque mandatory authorization ID to explicit actor/start state.
2. Make `credentialId` optional; require it only when `authMode` is `TEST_CREDENTIAL`.
3. Bind the approved hostname to the parsed HTTPS endpoint and disallow production environments in validation.
4. Keep fixed catalog and hard limits as the sole executable input.

**Tests:** endpoint/hostname parity; HTTPS-only; missing credential for credential mode; credential-free public mode; production rejection; fixed-catalog rejection.

### 2. Add tenant-scoped persistence and RLS

**Files:** Prisma schema/migration, DB service, migration/RLS tests.

1. Add domain-verification, reusable safety-settings, immutable plan, and run models.
2. Use workspace/target composite uniqueness and foreign keys to prevent cross-tenant tuples.
3. Enable and force RLS for every new table and include them in `WORKSPACE_SCOPED_MODELS`.
4. Persist domain proof expiry, challenge state, verification method, auditable plan/run states, receipts, and terminal reason—not prompts or responses.

**Tests:** migration replay; missing workspace context fails closed; a restricted `NOBYPASSRLS` role cannot cross tenants; mismatched workspace/target/credential rejected; plan/run immutability.

### 3. Implement remote-target proof and paid-scan admission

**Files:** target ownership service/routes, scan admission path, tests.

1. Issue a DNS TXT challenge per normalized registrable domain, with a short expiry and cryptographically random token.
2. Verify the TXT record using a bounded resolver and record a 90-day verified window; revalidate before expiry without forcing a new customer flow.
3. Add an optional Search Console verifier boundary that uses a configured read-only Google connection and accepts only an owner/full permission for the domain property. Do not request broad Google scopes or store Google tokens outside the existing credential mechanism.
4. Gate paid remote URL/API admission on current proof. Preserve repository installation proof and free local scans unchanged.

**Tests:** DNS challenge issuance, success, expiry, missing/incorrect record, same-domain reuse, cross-workspace denial, paid URL/API denial before proof, paid repo and free local regression.

### 4. Implement the live-safety service, APIs, and worker job

**Files:** app routes/services, queue contract, worker runner, SSRF tests.

1. Use the existing `AgentApproval` primitive only for member-requested starts. For Owners/Security Admins, create and consume an auditable self-approval when they press Start.
2. Resolve the target hostname before every request; reject redirects, non-public DNS answers, private/link-local/metadata IPs, hostname changes, invalid TLS, and over-limit bodies.
3. Enforce exact fixture requests, concurrency one, request/duration/body limits, and workspace/operator kill switches.
4. Persist only redacted deterministic receipts and predicate outcomes. Never send raw samples to telemetry, reports, or triage context.

**Tests:** entitlement/role/environment/domain-contact gates; credential reference access; redirect/SSRF/DNS-rebinding/body/time/kill failure; only deterministic predicates can set outcomes; stop idempotency.

### 5. Ship the least-friction dashboard experience

**Files:** target settings and scan-detail UI/components, Playwright/accessibility tests.

1. Add a one-time `Verify domain` panel with DNS as default and Search Console when available.
2. Add reusable `Safety testing defaults`: incident contact and a `No sign-in required` default.
3. Implement a short three-step wizard: choose verified non-production target, select fixed safe checks and limits, then review/start or request approval.
4. Provide honest inline blockers with direct actions, explicit terminal states, keyboard support, focus restoration, status announcements, no layout shift, and responsive 390px/mobile layouts.

**Tests:** Owner happy path, member approval request, DNS pending/failure, public/no-credential target, credential target, unverified/production denials, stop, dark/light/mobile/keyboard, and no-console-error checks.

### 6. Operations, configuration, privacy, and release proof

**Files:** `.env.example`, worker config/runbook, metrics/tests, product/release docs.

1. Add explicit kill-switch and limit configuration with safe defaults disabled until configured.
2. Add privacy-safe counters and runbooks for verification failure, kill switch, DNS/redirect failure, credential failure, and worker rollback.
3. Update claims/docs to say domain verification demonstrates control of the requested remote target, not system safety or legal authorization.
4. Run unit, migration, RLS, worker-contract, lint, typecheck, build, security, and focused E2E checks. Use staging only after approval, then record exact commit/image/migration/review evidence.

## Delivery order

1. Merge and verify the narrow release hotfix (#296), including database catalog remediation and exact worker digest promotion.
2. Land contracts, schema/RLS, and proof/admission in one reviewable PR.
3. Land runner/API and product wizard in a second PR.
4. Land operations/docs and final release evidence in a third PR.

## External gates

- Google Search Console convenience verification needs a configured Google OAuth client/consent with the official read-only Search Console scope. DNS remains fully usable without it.
- A real live test needs a paid workspace, customer-owned verified non-production endpoint, and a target selected by that customer. Local/fixture coverage proves the implementation but is not customer-environment proof.
- Production migration, image promotion, and deployed accessibility review require their respective Azure/Supabase/deployed-environment authority and must be recorded separately from local tests.
