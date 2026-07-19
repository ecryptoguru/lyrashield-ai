# LyraShield AI production beta readiness plan

Status: **proposed — not implemented or approved for deployment**
Date: 2026-07-20
Target: invite-only production beta with a small number of real users
Primary constraints: production-grade safety, truthful beta UX, Supabase Free, Upstash Free, low Azure cost, and controlled GPT-5.6 spend without a material quality reduction.

## 1. Outcome

Launch a real, invite-only LyraShield AI beta in which users can authenticate, create authorized repository targets, run bounded scans, inspect findings and evidence state, retest, and view reports. The marketing site remains on Cloudflare. The authenticated application, database, Redis queue, evidence storage, and sandbox-capable worker are deployed separately.

The beta is ready only after:

1. all release-blocking security and tenant-integrity findings are closed or explicitly removed from the beta surface;
2. production migrations, backups, restore drill, health checks, queue recovery, and rollback are proven;
3. one approved Safe scan and one approved Deep scan complete through the production worker lifecycle;
4. model usage, provider-billed cost, latency, evidence storage, and result quality are reconciled;
5. the live marketing and dashboard surfaces visibly identify the product as Beta;
6. the rollout remains invite-only with one scan executing at a time.

## 2. Scope and non-goals

### Included

- Existing Cloudflare marketing site and passive Lite Check.
- Authenticated Next.js dashboard.
- Better Auth email verification and invited beta accounts.
- Supabase Postgres for authenticated application data only.
- Upstash Redis over TLS for BullMQ and distributed rate limiting.
- One sandbox-capable worker host.
- Private Cloudflare R2 evidence storage.
- Luna/medium for focused work and Terra/medium for the Deep coordinator.
- Safe, Standard, and founder-approved Deep repository scans.
- Findings, evidence state, retests, reports, readiness, audit logs, and internal usage accounting.

### Excluded from the first beta

- Public self-service signup.
- Billing and paid plans.
- Unlimited scans or unlimited concurrency.
- Automatic Fix PR execution.
- Unverified fresh GitHub App installation claims.
- Arbitrary URL execution through the repository engine.
- General scanning of untrusted targets before transport-level egress controls are proven.
- Enterprise SSO, SCIM, private workers, BYOK/BYOM, or compliance claims.
- Vector embeddings/RAG until an evaluation shows that they improve quality or reduce total model cost.

## 3. Proposed minimum architecture

| Surface | Service | Minimum beta configuration | Expected base cost |
| --- | --- | --- | ---: |
| Marketing and waitlist | Existing Cloudflare Worker, D1, KV, Rate Limits | Keep current production deployment | Existing/free-tier usage |
| Passive Lite Check | Existing Azure Container App | 0.5 vCPU, 1 GiB, min 0, max 1 | Expected within shared ACA grant at low traffic |
| Authenticated web/API | Azure Container Apps Consumption | 0.5 vCPU, 1 GiB, min 0, max 1 | Expected within shared ACA grant at low traffic |
| Application database | Supabase Free Postgres | Runtime pooler URL; direct URL only for migrations/backups | $0 while within Free limits |
| Queue and rate limits | Upstash Free Redis | TLS Redis URL, one worker, measured command budget | $0 below Free command/storage limits |
| Evidence and backups | Private Cloudflare R2 | Separate evidence and database-backup prefixes or buckets | $0 within R2 Free limits |
| Worker | Azure D2as v5 Linux VM | 2 vCPU, 8 GiB, 64 GB Standard SSD, one active scan | About $45.87/month continuously running |
| Container images | Public GHCR packages | Immutable image digests | $0 for public packages |
| Transactional email | Brevo Free | Verification and invitations only | $0 below 300 emails/day |
| CI and backup automation | GitHub Actions standard public-repo runners | Pinned actions and scheduled jobs | $0 for standard runners on a public repo |
| Models | Azure-hosted GPT-5.6 Luna and Terra | Luna specialists; Terra only as Deep coordinator | Usage-based, reported separately |

Why the worker remains a VM: the current engine launches a digest-pinned Docker sandbox and needs controlled host runtime access. Azure Container Apps does not provide the required privileged host/Docker boundary. Replacing the VM requires a separate sandbox-service architecture and is not a beta prerequisite.

The cheapest alternative is to deallocate the VM outside published scan windows. That reduces compute cost but makes scans unavailable while the worker is off because admission correctly fails closed. Use this only if the beta explicitly promises scan windows rather than continuous scan availability.

## 4. Current cost envelope

Pricing is a planning snapshot and must be refreshed immediately before provisioning.

- Azure Central India D2as v5: approximately `$0.0556/hour`, or `$40.59/month` at 730 hours.
- Azure 64 GB Standard SSD E6: approximately `$5.28/month`.
- Always-on worker subtotal: approximately `$45.87/month`.
- Retaining the existing Azure Container Registry adds roughly `$5/month`; moving immutable public images to GHCR removes that line after pull verification.
- Azure Container Apps offers monthly free grants and scale-to-zero; both LyraShield container apps share the subscription-level allowance. Do not promise `$0` until actual meter data confirms combined usage.
- Upstash Free currently provides 256 MB and 500,000 commands/month. PAYG is the cheapest overflow path at approximately `$0.20/100,000` commands; upgrading is preferable to losing queue availability.
- Supabase Free currently provides a 500 MB database and 5 GB egress, but no managed backups and projects may pause after inactivity.
- R2 currently includes 10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and free egress.
- Brevo Free currently permits up to 300 emails/day after sender approval.

Official sources:

- [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
- [Azure D-series VM sizes](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dasv5-series)
- [Supabase pricing](https://supabase.com/pricing)
- [Upstash Redis pricing comparison](https://upstash.com/blog/redis-pricing-comparison-every-major-provider-in-2026-with-numbers)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [GitHub public package pricing](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages)
- [GitHub Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [Brevo pricing](https://www.brevo.com/pricing/)

### Model-cost planning examples

The most recent controlled local measurements are planning inputs, not provider invoices:

- Safe/Luna run: approximately `$1.00`, about 654 seconds.
- Deep Terra-coordinator plus Luna-specialist run: approximately `$4.65`, about 1,245 seconds.

Example first-month model envelope:

| Usage | Estimated model cost |
| --- | ---: |
| 10 Safe scans + 2 Deep scans | Approximately $19.30 |
| 20 Safe scans + 4 Deep scans | Approximately $38.60 |
| 40 Safe scans + 8 Deep scans | Approximately $77.20 |

Every production run must be reconciled against the Azure provider meter. Internal token accounting is diagnostic evidence, not the invoice.

### Expected first-month total

- Continuous scan availability: approximately `$46–55` infrastructure plus model usage.
- Ten-user controlled beta example: approximately `$65–75` including the model example above.
- Scheduled worker windows: potentially `$15–35` infrastructure plus model usage, depending on VM uptime, but with explicitly reduced scan availability.

## 5. Upstash Free command plan

The existing registry heartbeat performs three Redis commands per interval: remove expired workers, add the current lease, and refresh key expiry.

- Previous 10-second interval: about 777,600 commands per 30-day month before any scans.
- Proposed/working 45-second interval: about 172,800 commands per 30-day month.
- Worker expiry remains three missed heartbeats: 135 seconds.

This leaves about 327,200 Free-tier commands for BullMQ, readiness checks, reconciliation, schedules, rate limiting, and real scan traffic. It is not enough evidence to claim the complete queue remains free.

Before launch:

1. Deploy the 45-second heartbeat to a non-production Redis database.
2. Run one worker for 48 hours with no scans and record actual Upstash commands/day.
3. Run 10 Safe and 2 Deep representative jobs and record incremental commands/job.
4. Project a 30-day total using idle traffic plus the beta quota.
5. Keep projected normal usage below 350,000 commands/month, leaving 30% operational headroom.
6. Alert at 350,000 and prepare PAYG before 450,000; never let Redis exhaustion silently corrupt queue state.

Potential optimization, only after measurement:

- Move the reconciliation safety sweep from every minute to every five minutes. Immediate BullMQ failure callbacks remain active, while worst-case orphan detection increases from roughly six minutes to roughly ten minutes.
- Remove heartbeat cleanup or expiry refresh only if multi-worker and stale-key tests prove the simpler lease remains fail-closed.
- Do not replace BullMQ with a custom queue to save a few dollars.

## 6. Supabase Free production boundary

Use Supabase only as managed Postgres. Keep Better Auth, Prisma, Redis, evidence storage, and application authorization in their existing layers.

Required configuration:

1. Use the exact pooled runtime connection string from the Supabase Connect panel for `DATABASE_URL`.
2. Use the exact direct connection only for migrations and backups through `DATABASE_DIRECT_URL`.
3. Require certificate verification; never use `sslmode=disable` or an unverified guessed pooler host.
4. Cap application connections for the small Free instance and keep Azure Container Apps at max one replica initially.
5. Use a restricted application database role, not the Supabase owner/superuser role.
6. Verify every workspace table remains tenant-scoped and RLS fails closed when workspace context is missing.
7. Track database size and alert at 350 MB; stop nonessential retention growth before 450 MB.
8. Store no scan artifacts or raw engine output in Postgres.

### Backup and restore requirement

Supabase Free has no managed backups. Before storing beta data:

1. Run a nightly `pg_dump --format=custom --schema=public --no-owner --no-acl` from the direct URL.
2. Encrypt the dump client-side with a dedicated backup encryption secret.
3. Upload it to a private R2 database-backup bucket or prefix.
4. Configure an R2 lifecycle policy for 35 daily backups and 12 monthly backups, within the storage ceiling.
5. After every backup, retrieve the object metadata and checksum.
6. Weekly, download the latest object, decrypt it, and restore into an ephemeral PostgreSQL 16 database.
7. Verify migration records, key table counts, audit-chain validation, and application startup against the restored database.
8. Define beta targets of RPO 24 hours and manual RTO 4 hours. Do not advertise stronger recovery until measured.

Backup logs must not print database URLs, encryption secrets, target names, user email addresses, or dump content.

## 7. Evidence storage

Provision a separate private R2 bucket for full-scan evidence. Do not reuse the public marketing-media bucket.

1. Disable public access and custom public domains.
2. Create narrowly scoped R2 credentials limited to the evidence bucket.
3. Configure `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_REGION=auto` only in worker secrets.
4. Retain the existing application-level checksum and encryption-key reference requirements.
5. Apply a beta retention policy, initially 30 days for scan artifacts unless a report must retain evidence longer.
6. Test upload, retrieval, checksum verification, expiry, and hard failure when storage is unavailable.

No full scan is admitted if evidence storage is missing or a required artifact cannot be uploaded.

## 8. Application and worker sizing

### Authenticated web/API

- Azure Container Apps Consumption.
- 0.5 vCPU and 1 GiB RAM.
- Minimum replicas 0, maximum replicas 1.
- HTTP concurrency limit chosen after a small load test.
- Startup/readiness probes for `/api/health` and `/api/ready`.
- Scan readiness monitored separately through `/api/ready/scans`.
- Use managed identity for image pulls; disable ACR admin credentials if ACR is temporarily retained.

Accept an initial cold start for the invite-only beta. Move to minimum one replica only if measured user-facing cold starts are unacceptable.

### Worker

- One D2as v5 VM, 2 vCPU and 8 GiB RAM.
- 64 GB Standard SSD.
- One worker process and one active scan at a time.
- Non-root service account.
- Docker socket access restricted to that service account and owned sandbox resources.
- Pinned worker and sandbox image digests.
- Host firewall, restricted inbound access, and controlled outbound DNS/HTTPS.
- Automatic security updates during a defined maintenance window.
- VM logs and disk alerts with no raw target content.

The current worker concurrency of three is too aggressive for the minimum VM. Add a bounded production configuration and set beta concurrency to one before deployment.

## 9. AI routing and deep cost optimization

Keep the current quality-preserving route:

- Safe, Quick, and Standard: Luna with medium reasoning.
- Deep root coordinator: Terra with medium reasoning.
- Deep focused specialists: Luna with medium reasoning.
- Terra may not spawn Terra children or promote a specialist.

Retain finite server-side per-request and per-scan safety caps. They remain private operational controls and are not shown as user-facing pricing. Removing all hard limits is not production-safe because a malformed or adversarial scan could create unbounded provider spend.

### Context/token reductions

Prioritize these changes before any model-tier increase:

1. Build the repository manifest once and give child specialists only their assigned paths and bounded dependency context.
2. Use deterministic `rg`/path/language selection before model retrieval.
3. Exclude generated output, vendored dependencies, binaries, caches, coverage, and unrelated history before prompts are assembled.
4. Keep root instructions and target policy in a reusable stable prefix to maximize provider prompt-cache reuse.
5. Pass child summaries and evidence references back to the coordinator, not complete child transcripts.
6. Hash file slices and avoid resending unchanged content within the same scan.
7. Set byte/token ceilings per specialist and record every truncation as a coverage limitation.
8. Limit specialist count using repository size and language boundaries rather than allowing every agent to traverse the root.
9. Evaluate cost, latency, finding recall, false positives, and evidence completeness on the same fixed corpus before and after each optimization.

### RAG/vector embeddings decision

Do not add vector embeddings for the first beta.

Repository scans are highly freshness-sensitive and already have exact paths, symbols, imports, lockfiles, and language boundaries. Lexical/path retrieval plus bounded file slices is cheaper, simpler, and easier to explain in coverage receipts. A vector index adds embedding cost, storage, deletion/synchronization work, tenant isolation risk, and stale-context failure modes.

Reconsider RAG only if evaluation shows all of the following:

- repeated repository traversal remains a major token source after deterministic filtering;
- semantic retrieval improves recall on cross-file issues;
- total embedding plus retrieval cost is lower than the input-token savings;
- indexes can be tenant-isolated, version-bound, encrypted, and deleted reliably;
- stale or omitted context is reported as a coverage limitation.

## 10. Beta product and UI treatment

### Marketing landing page

1. Add a compact `Beta` badge next to the LyraShield AI brand in the shared header.
2. Change the homepage eyebrow to `Production beta · Release assurance for AI-built apps`.
3. Replace `Full platform in active development` with `Full platform available to invited beta users` only when authenticated beta access is actually deployed.
4. Keep the passive Lite Check boundary and no-account wording unchanged.
5. Link sign-in only when `PUBLIC_APP_URL` points to the live authenticated origin.

### Dashboard

1. Add the same `Beta` badge beside the brand in desktop and mobile shared navigation.
2. Add a concise beta notice to Settings explaining limited availability, support contact, and that scans are scoped evidence rather than a security guarantee.
3. Preserve all current loading, empty, error, and scan-service-unavailable states.
4. Do not expose model cost, internal caps, provider accounting, or infrastructure status to users.

### Copy acceptance criteria

- `Beta` is visible at 320 px, 390 px, tablet, and desktop widths without header overflow.
- Screen readers encounter the label once per visible navigation surface.
- Public copy does not claim complete coverage, independent verification without receipts, automatic PR fixes, customers, benchmarks, pricing, or GA availability.

## 11. Security and integrity gates

Before external invitations, re-verify and close these known risk families against current `main`:

1. Scorecards cannot become share-eligible when required controls are blocked or coverage is materially incomplete.
2. Workspace RLS and application scoping fail closed when context is absent.
3. The runtime database role is restricted and cannot bypass tenant isolation through ownership/superuser privileges.
4. Fresh GitHub installation ownership remains blocked unless provider ownership is proven. If not fixed, beta targets are operator-approved public repositories or pre-bound installations only.
5. Fix PR execution remains disabled until a server-generated immutable patch is bound to consumed approval.
6. Engine output remains untrusted, bounded, schema-filtered, and unable to mark itself independently verified.
7. URL targets never enter the repository engine.
8. Target allowlisting compensates for incomplete transport-level egress protection during the small beta. Do not open arbitrary repository/URL submission until DNS pinning and outbound policy are proven.
9. Evidence uploads fail closed and never use placeholders.
10. Audit chains, deletion attribution, referral boundaries, and private usage accounting pass their regression suites.

Any confirmed cross-tenant access, fail-open RLS, exposed secret, unsafe migration, missing backup restore, or unbounded provider call blocks deployment.

## 12. Observability and operational controls

Minimum beta alerts:

- Web readiness unhealthy for five minutes.
- Scan readiness remains 503 outside an announced worker deployment window.
- All worker heartbeats expire.
- Queue reconciliation repairs drift or fails.
- Oldest waiting job exceeds ten minutes.
- VM CPU above 85%, memory above 85%, or disk above 75% for a sustained period.
- Upstash projected monthly commands exceed 350,000.
- Supabase database exceeds 350 MB or connection utilization exceeds 70%.
- Backup missing for 30 hours or restore drill missing for eight days.
- Evidence upload/retrieval failure.
- Provider usage mismatch or scan safety-cap stop.

Operational ownership must name one person for deployment, incident response, backup restore, provider cost review, and user support. For the first beta these may all be the founder, but the responsibility and response path must be written down.

## 13. Implementation phases

### Phase 0 — approve scope and freeze the release surface

Actions:

- Approve this plan and the invite/user/target limits.
- Decide continuous worker availability versus published scan windows.
- Confirm the production application hostname.
- Confirm the correct Supabase organization/project and Azure subscription.
- Confirm the first approved public repository targets.

Exit criteria:

- No unresolved ownership/account ambiguity.
- No unapproved service provisioning.
- A named rollback owner and incident owner.

### Phase 1 — close code-level launch blockers

Actions:

- Re-run the current full local security/integrity review against `main` without provider scans.
- Fix confirmed P0/P1 tenant, scorecard, database-role, and provider-ownership issues.
- Keep unavailable flows visibly disabled and fail closed.
- Add focused regression tests for every confirmed fix.

Exit criteria:

- No confirmed external-beta blocker remains.
- Full local CI and migration drift checks pass.

Rollback:

- Revert the focused PR; no infrastructure has changed.

### Phase 2 — implement cost and beta UI changes

Actions:

- Land the 45-second/135-second heartbeat with tests and updated readiness documentation.
- Measure Redis before changing reconciliation cadence.
- Add bounded worker concurrency of one.
- Add marketing and dashboard Beta labels.
- Add truthful beta support/availability copy.

Exit criteria:

- Focused unit tests, marketing tests, lint, typecheck, build, and mobile/desktop rendered QA pass.
- Upstash idle projection is below the target envelope.

Rollback:

- Restore prior heartbeat and UI copy in one application PR; worker registration remains fail closed.

### Phase 3 — provision data and storage

Actions:

- Create/confirm Supabase Free project and exact pooled/direct TLS connections.
- Apply all migrations using the direct URL.
- Create restricted runtime role and verify RLS.
- Create Upstash Free Redis and configure `REDIS_URL` over TLS.
- Create private R2 evidence and backup storage with scoped credentials and lifecycle rules.
- Configure nightly encrypted backup and weekly isolated restore drill.

Exit criteria:

- Migration drift is zero.
- Two-account tenant isolation passes.
- Restore drill succeeds from an R2-retrieved encrypted dump.
- Evidence upload/retrieval/checksum tests pass.

Rollback:

- Keep projects private, remove application credentials, and retain the encrypted backup for the agreed retention window.

### Phase 4 — deploy authenticated web/API

Actions:

- Build and publish an immutable public GHCR image.
- Deploy Azure Container App at min 0/max 1.
- Configure secrets, origins, email, database, Redis, and proxy trust.
- Add the application hostname and TLS.
- Set marketing `PUBLIC_APP_URL` only after auth and readiness pass.

Exit criteria:

- Health, readiness, auth verification, onboarding, tenant denial, dashboard, and scan-service-unavailable paths pass on the live origin.
- Cold-start latency is measured and accepted.
- No secrets appear in logs or client bundles.

Rollback:

- Route traffic to the previous revision and unset `PUBLIC_APP_URL` from marketing.

### Phase 5 — deploy worker and sandbox

Actions:

- Provision/harden one D2as v5 VM.
- Install the immutable worker and inspected sandbox digests.
- Configure non-root service, internal sandbox network, evidence storage, Redis, Postgres, and model secrets.
- Start with concurrency one.
- Verify registration, heartbeat expiry, cancellation, shutdown, and queue reconciliation.

Exit criteria:

- `/api/ready/scans` becomes healthy only after BullMQ-ready registration.
- It becomes unhealthy within the documented 135-second lease window after worker stop.
- No orphaned container, network, file, or job remains after controlled cancellation.

Rollback:

- Stop/deallocate VM, revoke its secrets, and keep web scan admission fail closed.

### Phase 6 — controlled production scans

Actions:

- Run one approved Safe scan using Luna/medium.
- Inspect lifecycle events, findings, coverage, evidence, cleanup, latency, tokens, and Azure meter cost.
- Run one approved Deep scan using Terra/medium coordinator and Luna/medium specialists.
- Compare result quality and cost against the prior controlled baseline.
- Retest at least one deterministic finding path without replaying paid work accidentally.

Exit criteria:

- Both scans reach a truthful terminal state.
- Exact provider cost is reconciled.
- No unsupported verification/share claim is produced.
- Evidence is retrievable and cleanup completes.

Rollback:

- Disable scan admission, retain audit/accounting evidence, and investigate without automatically replaying provider work.

### Phase 7 — invite-only rollout

Actions:

- Invite two internal/founder accounts first.
- Expand to five users after 48 healthy hours.
- Expand to ten users after seven healthy days and a successful backup restore.
- Review Upstash, Supabase, Azure, R2, email, and model meters daily during week one.

Exit criteria:

- No P0/P1 incident.
- Queue and scan latency remain inside the beta target.
- Free-tier usage projections retain at least 20% headroom or a paid fallback is enabled.
- Support and incident response are exercised once.

## 14. Verification matrix

| Gate | Required evidence |
| --- | --- |
| Source quality | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, formatting, `git diff --check` |
| Database | Prisma generation, migration diff, deploy to empty DB, deploy to production, restricted-role checks |
| Browser | Marketing and dashboard at desktop, 390 px, and 320 px; keyboard, focus, reduced motion, empty/error states |
| Auth | Signup/invite, email verification, signin, signout, session expiry, cross-tenant denial |
| Queue | Admission, one concurrency, heartbeat expiry/recovery, cancellation, failure callback, reconciliation |
| Storage | Evidence upload/download/checksum, missing-storage failure, encrypted backup and isolated restore |
| Models | Luna Safe and Terra/Luna Deep routes, reasoning level, token buckets, provider cost reconciliation |
| Security | Secrets/SCA gates, prompt-injection guard, engine-output bounds, target allowlist, no URL-engine execution |
| Deployment | Immutable digests, health/readiness, logs/alerts, rollback to prior revision, VM deallocation recovery |
| Live truth | Marketing Beta label, dashboard Beta label, app link only when live, no unsupported claims |

## 15. Go/no-go decision

### Go for limited production beta

- All P0/P1 gates pass.
- Backup and restore are proven.
- One Safe and one Deep production scan are reconciled.
- The app is invite-only and one scan runs at a time.
- Free-tier projections retain headroom or cheap PAYG fallback is ready.
- Known unavailable features remain disabled and truthfully described.

### No-go

- Cross-tenant or RLS failure.
- Missing restricted database role.
- Missing/retrieval-failing evidence storage.
- No verified backup restore.
- Worker cannot cleanly stop or expires without scan admission failing closed.
- Provider usage cannot be reconciled or requests can run without finite safety limits.
- Scorecards can overstate blocked/incomplete coverage.
- Marketing links to an app origin that is not live and verified.

## 16. Post-beta optimization checkpoints

After two weeks or 50 completed scans, whichever comes first:

1. Calculate actual infrastructure cost per active beta user and per completed scan.
2. Calculate Luna and Terra cost, latency, cache hit rate, and tokens by scan mode.
3. Compare actual Upstash command usage with the projection.
4. Decide whether to keep the VM always on, introduce explicit scan windows, or build a cold-start worker coordinator.
5. Decide whether Supabase Free remains below 70% of database/connection/egress limits.
6. Evaluate context-slicing improvements before RAG or a higher model tier.
7. Expand beyond ten users only after capacity, recovery, and untrusted-target egress controls are proven.

This plan intentionally chooses the smallest production path that preserves tenant safety, evidence integrity, recovery, and bounded provider spend. It does not treat free-tier availability as a substitute for monitoring or a paid fallback.
