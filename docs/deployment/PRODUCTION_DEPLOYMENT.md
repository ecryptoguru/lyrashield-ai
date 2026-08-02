# LyraShield AI — Production Deployment Gate

> No production deployment is approved by this document. It records the minimum gates that must be satisfied before a release. Choose vendors and infrastructure only after founder approval; do not copy local Docker Compose into production.

`userguide.md` documents the end-user experience. This runbook owns only deployment, configuration, verification, and operational release boundaries.

## Architecture boundary

- The Next.js web application and BullMQ worker need managed PostgreSQL and Redis.
- The worker runs the `lyrashield` CLI and may launch a sandbox. Its host and Docker access are high-risk infrastructure.
- The Astro marketing site is an independent Cloudflare Worker with D1 and Cloudflare Rate Limits.
- Public scorecard pages, social card images, SVG badges, referral capture, and privacy-safe funnel events are served by the Next.js app origin, not the marketing Worker.
- S3-compatible evidence storage is mandatory for scans that may produce PoC/code-location artifacts. Email, GitHub OAuth/App integration, and monitoring providers use separate credentials.

## Known production blockers

Accepted risks that are live right now. Each one is a deliberate decision, not an oversight, and each has a defined way out. Review this list before any traffic-growth campaign.

### 1. Email verification is disabled — open registration accepts unverified addresses

**Status:** accepted, deferred. `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0` is set explicitly in `.github/workflows/deploy-azure.yml` and `.env.example`.

**Exposure.** Registration is open, so anyone can create an account against an address they do not control and it will reach the dashboard. That permits impersonation of a real person or brand (`ceo@customer.example`), bot and throwaway sign-ups, and inflated activation numbers. Referral attribution is partly protected — rewards only settle after a referred workspace completes a real scan — but sign-up-level abuse is unmitigated.

**Why it is deferred.** No Brevo key is provisioned. The schema default is `"1"`, and production config validation refuses to boot when verification is required but undeliverable, so the flag must be `"0"` until a mail provider exists. That refusal is intentional: the app will not claim to verify addresses it cannot actually mail.

**Way out (small, well-defined).**

1. Provision a Brevo API key and a verified sender address.
2. Set `BREVO_API_KEY` and `EMAIL_FROM` as production secrets.
3. Set the `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` repository variable to `1` (the deploy workflow reads it, defaulting to `0`).
4. Deploy. `packages/auth` enforces verification once the flag and the provider are both present; the boot-time refinement in `packages/config/src/env.ts` guarantees the two can never disagree.

**Do not** re-enable the flag without the key. The deploy will fail fast by design rather than silently accepting unverified sign-ups.

**Related history.** The flag was declared in the env schema and read by no code until 2026-07-30, so setting it previously had no effect and real behaviour derived from whether `BREVO_API_KEY` happened to be set. It is now authoritative.

### 2. Verify the runtime database role cannot bypass RLS

**Status:** unverified. Needs one query against production before the next traffic increase.

**Why it matters.** All 21 workspace-scoped tables carry fail-closed RLS policies and
`FORCE ROW LEVEL SECURITY`. `FORCE` subjects the table _owner_ to those policies — it does
**not** affect superusers or any role with `BYPASSRLS`. A superuser connection bypasses
row-level security unconditionally, so if `DATABASE_URL` connects as one, every policy is
inert and tenant isolation rests entirely on the application-layer Prisma extension. Managed
Postgres providers commonly hand out a superuser as the default user, so this is easy to
inherit by accident.

Verified empirically on 2026-07-30 against a local instance with the production migration
chain applied: as a superuser, a cross-workspace `SELECT` returned the other tenant's row
and a cross-workspace `UPDATE` modified it. As a `NOSUPERUSER NOBYPASSRLS` role, both
returned zero rows.

**How to check.**

```sql
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;
```

Both booleans must be `false`. If either is `true`, provision a dedicated runtime role and
point `DATABASE_URL` at it, keeping the privileged role only for migrations
(`DATABASE_DIRECT_URL`):

```sql
CREATE ROLE app_runtime LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE <db> TO app_runtime;
GRANT USAGE ON SCHEMA public, app TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
```

### 3. Shared rate limiting is enforced at deploy, not at boot

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are asserted by the deploy workflow
before the container image is swapped, and passed to both apps as secret references. Without
them the limiter falls back to a per-instance in-memory store, so the effective limit becomes
(limit x replica count) and scaling out to absorb load weakens the control.

This is deliberately a deploy gate rather than boot validation. Boot validation fires in
every production-mode process — including the Playwright E2E server — and would fail a
running app on restart, trading a rate-limiting weakness for an availability outage. The
deploy check catches the same misconfiguration at the only moment it can be fixed safely.

**Regression cover.** `packages/db/src/rls-fail-closed.test.ts` asserts the deny-by-default
behaviour against a real database, and refuses to run — rather than passing vacuously —
when handed a role that can bypass RLS. CI provisions that restricted role and exports
`RLS_RUNTIME_DATABASE_URL`.

### 4. Container registry cleanup — RESOLVED 2026-07-30, updated 2026-08-01

**Status:** live. `cleanup-old-images` in `deploy-azure.yml` runs after every successful
deploy with `dry-run: false`, removing dangling untagged manifests. Web/scanner images
keep the most recent 10 tagged versions; worker images keep the most recent 100 tagged
versions because the worker VM pins images by digest and the approved digest may lag
behind `main` deploys.

**Why this existed.** Every merge to `main` pushes a new SHA-tagged image and re-points
`:latest`; nothing ever deleted what it replaced. Multi-arch buildx pushes also leave several
untagged manifests per build. Confirmed 2026-07-30: `lyrashield-web` had 10 versions (6
untagged) and `lyrashield-worker` had 4 (3 untagged) after only a handful of deploys.

**Why it shipped in dry-run first.** Deleting container images is irreversible, and a naive
"delete this version ID" approach can remove an untagged manifest that a _kept_ tagged
manifest list still references, silently breaking a future pull of an image that still looks
valid. `dataaxiom/ghcr-cleanup-action` resolves manifest lists before deleting specifically to
avoid that, but a first run against accumulated history was reviewed before going live rather
than trusted blind.

**What the review found.** Run `30496418272`'s dry-run pass reported "no tagged images found
to delete" and "no untagged images found" for both packages — with `keep-n-tagged: 10` and
only ~10 total accumulated versions, nothing had aged out yet. The first live run is a
verified no-op, not a leap of faith; it starts actually pruning once deploy counts exceed the
keep threshold. The 2026-08-01 update splits worker cleanup into its own step with
`keep-n-tagged: 100`, emits `web_digest` and `worker_digest` from the build, and deploys
app/scanner images as `image:tag@sha256:<digest>` so the running container is pinned to an
immutable manifest even if the `:latest` tag moves.

### 5. Nightly backups have a schedule but no credentials — they are not actually running

**Status:** broken. Do not treat "the backup workflow is on a cron schedule" as "backups are
happening." As of 2026-07-30 every scheduled run fails immediately with `AWS_ACCESS_KEY_ID is
required`.

**What happened.** `production-backup.yml` was `workflow_dispatch`-only until 2026-07-30, when
a `schedule: cron("0 2 * * *")` trigger was added so nightly backups would not depend on
someone remembering to click a button. The first automatic run then failed at its very first
step. This is not a regression the schedule caused — the underlying credential gap already
existed and dispatch-only runs were apparently never exercised (or never checked) — but adding
the schedule is what surfaced it.

**Way out.** Provision S3-compatible storage credentials (`AWS_ACCESS_KEY_ID` and whatever
else the backup job's next failing step turns out to need — only the first missing variable
is visible until this one is fixed) as repository secrets. Confirm whether this should be the
same bucket/credentials as evidence storage (`S3_*` in the application config) or a dedicated
backup destination, then re-run `production-backup.yml` via `workflow_dispatch` to confirm a
real backup completes before trusting the nightly schedule.

### 6. GitHub App connect path requires app creation + 4 secrets — currently unprovisioned (blocks new signups)

**Status:** intentionally degraded, but unblocked by F1's four-way onboarding. As of 2026-07-30,
`LYRASHIELD_GITHUB_APP_ID`, `LYRASHIELD_GITHUB_APP_SLUG`, `LYRASHIELD_GITHUB_APP_PRIVATE_KEY`, and `LYRASHIELD_GITHUB_APP_WEBHOOK_SECRET` are
set as repo secrets and injected as `GITHUB_APP_*` env vars in the Container Apps.

**Exposure.** `POST /api/integrations/github/install` calls `getInstallAppUrl()`, which throws
`GITHUB_APP_SLUG not configured` when `GITHUB_APP_SLUG` is empty. The route catches it and
returns 500 `{ code: "CONFIG_ERROR", message: "GitHub App is not configured" }`. Previously
(days 1-3 of the beta, pre-F1) onboarding was REPO-only: step 2 was "Connect GitHub" as the only
way forward, and `(dashboard)/layout.tsx` redirects any user whose onboarding is neither
`completed` nor `skipped` back to `/onboarding`. A 500 on that one path = every new signup bricked.
That exact scenario was verified live in a browser on 2026-07-30.

**F1's fix (merged 2026-07-30):** step 2 is now a four-way choice: Connect GitHub / Add app URL
/`Add API / Skip`. The non-GitHub paths never call the install endpoint, and `connectGitHub()`
now explicitly degrades — it marks the GitHub option unavailable, keeps the three other paths,
and shows a stable `GitHub connect is unavailable right now…` message (never the raw server error).
A brand-new signup therefore survives without GitHub (URL/API scan or skip → dashboard) even while
the GitHub path 500s. The P0 is closed.

**Why the GitHub path still matters.** Without the GitHub App, private-repository scanning and any
flow that needs the App's `Contents: Read` / `Metadata: Read` / webhook delivery remain disabled.
For a beta that may grow from URL scans to repo scans, that is a real conversion drop-off. The App
path's own code is intentionally **failing closed**: the install callback (`GET
/api/integrations/github/install`) requires an existing workspace `Integration` binding for the
`installation_id` (IDOR / enumeration defense) and the deploy pipeline never creates a secret
from a callback-supplied parameter. Those gates are load-bearing, not placeholders — see
`PRODUCTION_DEPLOYMENT.md` prerequisites and `AGENTS.md`'s "GitHub installations and Fix PRs"
rule.

**Way out — one-time GitHub App creation + 4 repo secrets + deploy plumbing (already shipped).**

1. **Create the GitHub App** (owner: `ecryptoguru`, same account that owns `lyrashield-ai`):
   - `https://github.com/settings/apps/new`
   - **General**: name `LyraShield AI (app.lyrashieldai.com)`, description `Release assurance for AI-built apps — authorized repository scanning.`, homepage `https://lyrashieldai.com`.
   - **Webhook**: active; URL `https://app.lyrashieldai.com/api/webhooks/github`; generate a webhook secret now and save its value (it becomes `LYRASHIELD_GITHUB_APP_WEBHOOK_SECRET`). Subscribe to `Installation` (deleted signal) and `Pull request` (if Fix PR automation is on) delivery — unsubscribe from everything else.
   - **Repository permissions — start minimal** (expand only when the first flow that needs more lands; every permission addition requires re-authorizing installs):
     - `Contents: Read` — scan authorized code.
     - `Metadata: Read` — list repos for the `POST /api/integrations/github/repos` call.
     - `Pull requests: Read and write` — **only** when server-generated, approval-bound Fix PRs are implemented; until then `Read` is enough.
   - **Account permissions**: none required for today's beta (the install-URL uses the slug; listing installs needs the App JWT only).
   - **Privacy**: public App, but installable on specific `ecryptoguru` repos (or "all repos on the account" if the boundary is governed by the per-workspace allowed-repo list instead). Never enable "any account" until the multi-tenant billing / allowlist is gated.

2. **Note the four values the deploy pipeline needs:**
   - `GITHUB_APP_ID` — numeric app id from the App settings page (e.g. `1234567`).
   - `GITHUB_APP_SLUG` — the slug from the URL `https://github.com/apps/<slug>` (e.g. `lyrashield-ai`).
   - `GITHUB_APP_PRIVATE_KEY` — PEM private key: scroll to the bottom of the App settings page, `Generate a private key`, download the `.pem`, paste the full contents including `-----BEGIN RSA PRIVATE KEY-----`/`-----END RSA PRIVATE KEY-----`. GitHub rotates this immediately when a new one is generated — the old one stops working the instant the new one exists.
   - `GITHUB_WEBHOOK_SECRET` — the webhook secret you generated in step 1.

3. **Add them as repository secrets** in `ecryptoguru/lyrashield-ai` (Settings → Secrets and variables → Actions → Repository secrets):
   - `LYRASHIELD_GITHUB_APP_ID`, `LYRASHIELD_GITHUB_APP_SLUG`, `LYRASHIELD_GITHUB_APP_PRIVATE_KEY`, `LYRASHIELD_GITHUB_APP_WEBHOOK_SECRET`.

4. **Deploy wiring — already shipped in `.github/workflows/deploy-azure.yml` (PR #180+):**
   - `Verify GitHub App credentials` — warns (not errors) if any of the 4 secrets are missing, so existing deploys keep working; onboarding's three non-GitHub paths cover signups in the meantime.
   - `Sync GitHub App secrets to Container Apps` — when all 4 secrets are set, on every deploy it runs `az containerapp secret set` on both the app and scanner Container Apps with 4 secret names (`github-app-id`, `github-app-slug`, `github-app-private-key`, `github-webhook-secret`). Rotating a GitHub secret therefore also rotates the Container App's copy. When any one secret is missing the entire sync step is skipped (avoids half-configured deploys that would 500 on a different path).
   - `Deploy app Container App` / `Deploy scanner Container App` — `--set-env-vars` now includes `GITHUB_APP_ID=secretref:github-app-id` etc. `secretref:` requires the Container App to already define a secret with that name — provisioned by the sync step just above on every deploy, so rotation is automatic and a fresh Container App gets its secrets for the first time.

5. **Verify after the deploy:**
   - `curl https://app.lyrashieldai.com/api/ready` should still be `{"status":"ready",...}`.
   - As a brand-new signup, step 2 should show all 4 options and "Connect GitHub" should be enabled (not "GitHub connect is unavailable right now…").
   - Clicking "Connect GitHub" should open `https://github.com/apps/<slug>/installations/new?state=...` in a new tab (the `state` param is workspace-bound and signed — S2 defense), not 500.
   - `POST /api/webhooks/github` deliveries (GitHub App settings → Advanced → Recent Deliveries → Redeliver) should 200 and write `webhookEvent` rows (`@@unique([provider, externalId])` idempotency).

**Do not:**

- Hard-code PEM keys or webhook secrets in GitHub workflow files, Terraform, or `*.md` examples.
- Set any `GITHUB_APP_*` env var from workflow `vars` (non-secret) — they must come through `secrets` + `secretref:`.
- Add broader GitHub App permissions (e.g. `Administration`, `Organization`, `Checks: Write`) until the first flow that requires them lands and the extra permission is reviewed as part of that PR's threat model.

**Cleanup (auditor).** The two audit accounts created during the live repro:
`devagent-uxaudit2+20260730@fusionwaveai.com` and `devagent-uxaudit3+20260730@fusionwaveai.com` are now bricked in onboarding (workspace created, GitHub step unreachable at the time). Purge them after F1 lands (same as the earlier test waitlist row cleanup).

## Release prerequisites

1. Public HTTPS application and marketing origins plus all trusted auth origins are decided. Scorecard canonical/OG/Twitter URLs must resolve to the application origin.
2. Production Postgres migrations and the CI migration-drift check pass. Before applying `20260714170000_integration_global_external_id_unique`, resolve any duplicate non-null `(type, externalId)` bindings explicitly; the migration intentionally fails rather than silently reassigning an installation.
3. Redis is private/TLS-protected and reachable by both web and worker. `REDIS_URL` (redis://) is for the BullMQ job queue; `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (HTTPS REST) are for distributed rate limiting only. The two are never interchangeable.
4. All secrets are supplied through the platform's secret manager, never committed files.
5. The worker runs as a dedicated non-root user with least-privilege filesystem and Docker access.
6. The sandbox image is pinned to an inspected digest; mutable tags are not acceptable. The worker and each sandbox share a dedicated internal control-plane network that has no default external route.
7. Authorized Luna and Terra deployment names plus the matching provider credentials are available for a controlled scan; the fallback model is also configured and tested.
8. Egress policy, DNS pinning/proxying, logs, alerts, backup, and restore ownership are defined. If threat enrichment is enabled, permit bounded HTTPS access to the CISA KEV JSON feed and FIRST EPSS API.

## Full-scan resource checklist

The live Lite Scanner is a separate passive API and cannot be promoted into the full worker by configuration alone. A controlled repository scan requires all of the following:

- migrated PostgreSQL for application and scan state;
- a private/TLS `redis://` or `rediss://` service compatible with BullMQ and reachable by both web and worker—Upstash REST URL/token variables are for distributed rate limiting via `@upstash/ratelimit` and do not replace `REDIS_URL`. In production, `REDIS_URL` points to the Azure VM-hosted Redis instance, while `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` point to a separate Upstash free plan instance;
- a deployed authenticated Next.js application origin to create targets, authorize users, enqueue scans, and render retained results;
- dedicated worker compute with Git, the `lyrashield` CLI, the inspected engine source, controlled access to the digest-pinned sandbox runtime, and a dedicated internal network shared only with scan sandboxes;
- an authorized Luna/Terra/fallback model route and provider credentials;
- private S3-compatible evidence storage configured through all five `S3_*` values;
- secret management, TLS, monitoring, backup/restore, and deployment-level egress enforcement.

Brevo is required when production email verification or invitations are enabled. GitHub App credentials are required for private-repository integration flows. Slack/Discord, billing, and product analytics are optional integrations and are not scan-runtime dependencies.

## Required application configuration

Set the production values appropriate to the selected infrastructure:

```bash
DATABASE_URL="postgresql://..."
DATABASE_DIRECT_URL="postgresql://..." # direct migration connection when using a pooler
REDIS_URL="rediss://..."  # BullMQ job queue (Azure VM-hosted Redis in production)
UPSTASH_REDIS_REST_URL="https://..."  # Distributed rate limiting (separate Upstash instance)
UPSTASH_REDIS_REST_TOKEN="..."  # Required when UPSTASH_REDIS_REST_URL is set
BETTER_AUTH_SECRET="..."
BETTER_AUTH_URL="https://app.example.com"
NEXT_PUBLIC_APP_URL="https://app.example.com"
NEXT_PUBLIC_MARKETING_URL="https://www.example.com"
BETTER_AUTH_COOKIE_DOMAIN=".example.com" # only when app and marketing share a parent domain
ADDITIONAL_TRUSTED_ORIGINS="https://www.example.com"
TRUSTED_PROXY_IP_HEADER="x-forwarded-for" # only after ingress strips incoming copies

# Email. The schema default is "1" and production refuses to boot when verification
# is required but no provider is configured. Currently "0" — see
# "Known production blockers" above before changing it.
LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="0"
BREVO_API_KEY="..."
EMAIL_FROM="noreply@example.com"

# Optional OAuth sign-in/sign-up. Register these exact production callback paths:
# https://<app-origin>/api/auth/callback/github
# https://<app-origin>/api/auth/callback/google
# https://<app-origin>/api/auth/callback/microsoft
# OAuth sign-up is open when the provider is configured and credentials are complete.
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
AZURE_AD_CLIENT_ID="..."
AZURE_AD_CLIENT_SECRET="..."
AZURE_AD_TENANT_ID="common"

LYRASHIELD_LLM="azure/gpt-5.6-terra"
LYRASHIELD_LUNA_LLM="azure/gpt-5.6-luna"
LYRASHIELD_TERRA_LLM="azure/gpt-5.6-terra"
LLM_API_KEY="..."
LYRASHIELD_ENGINE_PATH="lyrashield"
LYRASHIELD_IMAGE="ghcr.io/usestrix/strix-sandbox@sha256:<approved-digest>"
LYRASHIELD_ENGINE_SANDBOX_NETWORK="lyrashield-sandbox"
PLATFORM_MAX_SCAN_BUDGET_USD="50"
LYRASHIELD_TELEMETRY="0"
LYRASHIELD_WORKER_CONCURRENCY="1"
# Optional per-request engine limits; leave unset for engine defaults.
# MAX_OUTPUT_TOKENS caps tokens generated per request (replaces the engine's
# per-scan-mode default; also tightens the budget reservation). MAX_INPUT_TOKENS
# is the compaction ceiling, not a hard reject -- crossing it compacts history
# instead of failing the scan, and the engine clamps values above the 272k
# long-context boundary. Requires an engine build with cap enforcement.
# LYRASHIELD_MAX_OUTPUT_TOKENS="4096"
# LYRASHIELD_MAX_INPUT_TOKENS="200000"

# Azure OpenAI alternative (use these OR the generic LLM_API_KEY/LLM_API_BASE)
# LYRASHIELD_LLM="azure/gpt-5.6-terra" # fallback
# LYRASHIELD_LUNA_LLM="azure/gpt-5.6-luna"
# LYRASHIELD_TERRA_LLM="azure/gpt-5.6-terra"
# AZURE_OPENAI_API_KEY="..."
# AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com"
# AZURE_API_VERSION="v1"

# Azure AI project / serverless alternative
# LYRASHIELD_LLM="azure_ai/gpt-5.6-terra" # fallback
# LYRASHIELD_LUNA_LLM="azure_ai/gpt-5.6-luna"
# LYRASHIELD_TERRA_LLM="azure_ai/gpt-5.6-terra"
# AZURE_AI_API_KEY="..."
# AZURE_AI_API_BASE="https://<resource>.services.ai.azure.com"
# AZURE_API_VERSION="v1"

# S3-compatible evidence storage (required before controlled scans)
S3_ENDPOINT="https://..."
S3_BUCKET="lyrashield-evidence"
S3_ACCESS_KEY="..."
S3_SECRET_KEY="..."
S3_REGION="auto"
```

### Model routing, reasoning, and spend limits

The worker selects one profile before each engine subprocess:

| Product mode | Engine mode | Model variable         | Reasoning | Default cap |
| ------------ | ----------- | ---------------------- | --------- | ----------: |
| Safe         | quick       | `LYRASHIELD_LUNA_LLM`  | medium    |       $1.20 |
| Quick        | quick       | `LYRASHIELD_LUNA_LLM`  | medium    |       $1.20 |
| Standard     | standard    | `LYRASHIELD_LUNA_LLM`  | medium    |       $3.20 |
| Deep         | deep        | `LYRASHIELD_TERRA_LLM` | medium    |      $15.00 |
| Custom       | deep        | `LYRASHIELD_TERRA_LLM` | medium    |      $15.00 |

The worker permanently versions the official OpenAI GPT-5.6 rate card in `apps/worker/src/engine/gpt56-pricing.ts` (effective 2026-07-09; USD per 1 million tokens):

| Model         | Input | Cached input read | Cache write | Output |
| ------------- | ----: | ----------------: | ----------: | -----: |
| GPT-5.6 Terra | $2.50 |             $0.25 |      $3.125 | $15.00 |
| GPT-5.6 Luna  | $1.00 |             $0.10 |       $1.25 |  $6.00 |

Source: OpenAI's official GPT-5.6 announcement and pricing, captured with its effective date. Cache writes are 1.25 times the uncached input rate. Requests whose prompts exceed 272,000 tokens use the official long-context multipliers of 2 times input and 1.5 times output. The parser assigns complete request entries to standard or long-context input/cache-write/cache-read/output buckets; aggregate counters that cannot identify which request crossed the boundary are not estimated locally.

`LYRASHIELD_LLM` is mandatory as the backward-compatible fallback when a routed variable is absent or empty. Azure deployment names are operator-defined: if the Azure deployment is not literally named `gpt-5.6-luna` or `gpt-5.6-terra`, put the real deployment name after `azure/` or `azure_ai/`.

A finite positive `Policy.maxBudgetUsd` overrides the default for that scan. Zero, negative, non-finite, missing, deleted, or cross-workspace policy values cannot remove the mode cap. The worker records `engine_start` with coordinator model/reasoning and retains accounting events privately. When the engine returns usage, the ledger retains provider telemetry, actual-model per-request buckets, the official rate-card calculation, calculation method, reconciliation status, request count, and normalized token counters. A numeric internal bill is written only when that rate-card amount is fully determined and agrees with provider-reported cost when one exists. Ambiguous long-context aggregates, missing billable dimensions, and mismatches remain unpriced and explicitly unreconciled; they do not turn a valid scan result into a fake failure. It never stores prompts or raw provider request payloads, and the dashboard renders no cost, spend, cap, or accounting-event value.

These amounts are internal hard ceilings, not expected per-scan charges or user-facing prices. Engine-reported telemetry is retained for reconciliation even when it exceeds the approved ceiling; the capped internal ledger cannot be presented as the provider invoice. Reconcile it against the Azure meter during the controlled gate; Azure billing remains the final expenditure source.

A durable scan event is recorded immediately before a repository scan enters the provider-billable engine phase. Preflight work remains retryable, while recovery after that boundary fails closed instead of replaying provider work; a failed billable invocation requires an explicit new scan or retest so the queue cannot silently duplicate model spend. Deterministic SCA, secret, URL, and agent-configuration findings use the Safe profile for targeted retests; engine-only findings retain their originating review depth.

Safe/Quick/Standard are Luna-only. Deep/Custom use a deterministic two-tier invocation: Terra/medium is the root coordinator and Luna/medium handles child specialist work. The model cannot self-promote a child to Terra, and only the root can create or stop specialists.

Engine PRs #6, #7, and #20 are merged. The promoted engine compacts estimated input at 240k toward 180k, bounds direct dedupe input to 200 kB, limits output and agent concurrency, reserves projected spend before each request, and accounts for provider-reported cache-read tokens with dict/object usage extraction. These controls do not replace provider-meter reconciliation or prove finding quality.

Add GitHub OAuth/App, email, notification, billing, and analytics variables only when those integrations are enabled. R2/S3 is mandatory before controlled full scans, and monitoring is mandatory before general availability. Use `.env.example` as the complete variable index, not as a production secret file.

## Verification before release

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
git diff --check
```

Then, in the target environment:

1. Deploy all 28 migrations before application processes serve traffic, including `20260713170000_scorecard_events`, `20260714170000_integration_global_external_id_unique`, `20260716150000_integration_external_id_check`, `20260716151000_scorecard_share_active_snapshot_unique`, `20260718110000_scan_cost_ledger`, `20260725132208_add_finding_status_reason`, `20260725160000_scan_workspace_status_index`, and `20260803000000_uxv2_schema`; run the migration-diff gate against a fresh shadow database.
2. Verify `/api/health`, `/api/ready`, `/api/ready/scans`, authentication, workspace isolation, Redis queue connectivity, and worker readiness. The scan-specific endpoint must become `503` within 30 seconds of stopping every worker and recover only after a BullMQ-ready worker registers its lease.
3. Verify the engine version and missing-model early-exit path.
4. Run a Safe or Standard controlled scan and verify its `engine_start` event names Luna with medium reasoning and its `budget_cap` event contains the expected default or policy amount.
5. Run a founder-approved Deep controlled scan and verify its `engine_start` event names Terra with medium reasoning and its cap is $15 or the selected positive policy override.
6. Capture audit evidence, confirm the sandbox image digest used, reconcile provider billing with the retained usage/rate-card ledger without treating it as an invoice, and verify evidence artifacts are retrievable from the configured S3-compatible endpoint. Any placeholder or failed upload blocks the gate.
7. Exercise backup and restore on non-production data before claiming an RPO/RTO.
8. Confirm URL targets use only the pinned deterministic URL scanner. Do not re-enable the external engine for URL targets until its transport is DNS-pinned and redirect-safe.
9. Confirm GitHub callbacks can refresh only a pre-existing workspace binding. Fresh installation claims and client-authored Fix PR payloads must remain blocked until their provider-ownership and server-generated-patch gates are implemented.

Queue recovery is deliberately fail-closed. Workers reconcile queue/database drift at startup and every 60 seconds under a renewable token-owned Redis lease. A scan left `QUEUED` for more than five minutes without a processable job becomes `FAILED` with `QUEUE_ORPHANED`; operators must not automatically requeue it because the original attempt may have crossed a paid-provider boundary.

Operational queue rules:

1. Use the authenticated scan cancellation action/API. It transitions the database scan to `CANCELLED`; the worker stops active phases and reconciliation removes a remaining non-active job.
2. Never delete BullMQ keys or jobs directly in Redis, and never change only the database row. Queue and scan state must retain one auditable lifecycle.
3. Before restarting workers, record counts for enabled schedules, non-terminal scans, and waiting/delayed/prioritized/active jobs. Investigate unexpected work before registration makes it eligible to run.
4. After restart, verify `/api/ready/scans`, worker logs, the same queue/database counts, and the absence of an unintended `engine_start` event.
5. Retry a failed/orphaned scan only through an explicit user/operator action that creates a new scan ID. Reconciliation never recreates paid work.

Alert when scan readiness remains 503 beyond the deployment window, every worker heartbeat expires, reconciliation reports drift, a queue-failure event is retained, queue depth grows without active workers, or the oldest waiting job exceeds the approved latency. Web `/api/ready` may remain healthy during a scan-service outage and must not mask this alert.

## Public scorecard, referral, and sharing gate

Use a founder-approved test workspace and a real eligible Standard/Deep score snapshot. Do not expose a private customer target for launch QA.

1. Publish a scorecard and verify the public page uses only the frozen allowlist: grade, scope line, scan date, score model version, and resolved-findings count. Confirm the page is `noindex` and links the public methodology.
2. Inspect canonical, Open Graph, and Twitter tags. Fetch both grade/fixes variants in wide (1200×630), square (1080×1080), and portrait (1080×1350) formats. Verify the SVG badge is script-free and short-cacheable.
3. Exercise native sharing where supported plus LinkedIn, X, Bluesky, WhatsApp, Reddit, email, copy, download, README badge, and Open. Each generated scorecard URL must retain `ref` and add only an allowlisted source/UTM value.
4. Open the public CTA in a fresh browser, create a new test account, and complete onboarding. Verify referral code and source survive their separate HttpOnly cookies, self/old-account attribution is rejected, and no reward is issued before the first real completed scan.
5. Verify event privacy and counting: crawler/image/badge fetches do not increment human views; same-session/day reloads deduplicate; DNT/GPC suppress client capture; stored events contain no target, repository, finding, raw IP, user-agent, or caption fields.
6. Revoke the share. The page, all image formats, and badge must return 404. Publish a newer eligible snapshot and verify the older still-public card shows only the boolean supersession notice, never the newer grade.
7. Validate at least the major launch channels against the real HTTPS URL. Social caches are independent deployment state; use official cache refresh/debug tools when available and retain screenshots/results with the release evidence.

Monitor only coarse funnel stages: deduplicated scorecard view, share-button handoff, new-account attribution, and first-scan qualification. Do not label handoffs as impressions or conversions, and do not export referral/session identifiers to third-party analytics.

## Marketing deployment

### Current pre-launch deployment status — 2026-07-16

- `https://lyrashieldai.com` is live on the `lyrashield-marketing` Worker. The apex and `www` custom domains are attached.
- Production D1, Rate Limit, and KV bindings are provisioned; migrations `0001`–`0003` are applied remotely; `WAITLIST_IP_SALT` is stored as a Worker secret.
- `PUBLIC_SITE_URL=https://lyrashieldai.com` and `PUBLIC_INDEXABLE=true`. The marketing, methodology, browser-local tools, and passive `/scan` surface are indexable. `/terms` remains page-scoped `noindex` and excluded from the sitemap.
- Live HTTPS, security headers, canonical/schema metadata, sitemap/robots/`llms.txt`, waitlist behavior, representative Lighthouse/Brave rendering, the permanent path/query-preserving `www`-to-apex redirect, and a production browser Lite Check pass.
- Production sets `PUBLIC_SCANNER_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, and `PUBLIC_ABUSE_EMAIL` together because the separately protected scanner API and monitored abuse workflow are live. Keep all three configured as one availability gate. `PUBLIC_APP_URL` is set to the authenticated app origin so marketing CTAs can link to open sign-up and sign-in.

Before deploying the Cloudflare marketing Worker:

1. Replace the D1 database ID and Rate Limit namespace placeholder in `apps/marketing/wrangler.jsonc`.
2. Apply all D1 migrations in `apps/marketing/migrations/` (including `0003_waitlist_referrals.sql`, which adds the waitlist referral columns) with `wrangler d1 migrations apply` before serving traffic. The waitlist API remains available for the homepage referral flow if configured.
3. Set `WAITLIST_IP_SALT` with `wrangler secret put`; do not retain the example value.
4. Build with the intended public origins. `PUBLIC_INDEXABLE=true` is rejected unless `PUBLIC_SITE_URL` is public HTTPS.
5. Deploy using Astro's generated configuration:

   ```bash
   PUBLIC_SITE_URL="https://lyrashieldai.com" \
   PUBLIC_SCANNER_URL="https://scanner.example.com" \
   PUBLIC_INDEXABLE=true \
     pnpm --filter @lyrashield/marketing build
   pnpm --filter @lyrashield/marketing exec wrangler deploy --config dist/server/wrangler.json
   ```

6. On the live domain, verify waitlist submission, queue position, Copy/LinkedIn/X/WhatsApp referral actions, referral-count movement, canonical URL, Open Graph image, JSON-LD, `robots.txt`, sitemap, app-header links, and HTTPS redirect. Confirm analytics contain only the allowlisted share channel. Do not enable indexing until visual QA and founder approval are complete.

## Do not claim as verified

- Docker image build or container health is not a sandbox-scan test.
- A local noindex marketing preview is not a live SEO verification.
- A locally rendered scorecard image is not proof that external social caches have fetched the current canonical asset.
- A scorecard share-button click is not a platform impression, signup, qualified referral, or customer claim.
- A green application CI run is not evidence of configured production secrets, DNS, billing, or backups.
- A database uniqueness migration passing on an empty environment is not evidence that legacy duplicate provider bindings were reconciled.
