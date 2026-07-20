# LyraShield AI — Production Deployment Gate

> This runbook is not a blanket production approval. The invite-only authenticated beta is deployed at `https://app.lyrashieldai.com`, while full repository scans remain unavailable until their dedicated worker, egress, and controlled-scan gates are independently proven. Choose vendors and infrastructure only after founder approval; do not copy local Docker Compose into production.

`userguide.md` documents the end-user experience. This runbook owns only deployment, configuration, verification, and operational release boundaries.

## Architecture boundary

- The Next.js web application and BullMQ worker need managed PostgreSQL and Redis.
- The worker runs the `lyrashield` CLI and may launch a sandbox. Its host and Docker access are high-risk infrastructure.
- The Astro marketing site is an independent Cloudflare Worker with D1 and Cloudflare Rate Limits.
- Public scorecard pages, social card images, SVG badges, referral capture, and privacy-safe funnel events are served by the Next.js app origin, not the marketing Worker.
- S3-compatible evidence storage is mandatory for scans that may produce PoC/code-location artifacts. Email, GitHub OAuth/App integration, and monitoring providers use separate credentials.

## Release prerequisites

1. Public HTTPS application and marketing origins plus all trusted auth origins are decided. Scorecard canonical/OG/Twitter URLs must resolve to the application origin.
2. Production Postgres migrations and the CI migration-drift check pass. Before applying `20260714170000_integration_global_external_id_unique`, resolve any duplicate non-null `(type, externalId)` bindings explicitly; the migration intentionally fails rather than silently reassigning an installation.
3. Redis is private/TLS-protected and reachable by both web and worker.
4. All secrets are supplied through the platform's secret manager, never committed files.
5. The worker runs as a dedicated non-root user with least-privilege filesystem and Docker access.
6. The sandbox image is pinned to an inspected digest; mutable tags are not acceptable. The worker and each sandbox share a dedicated internal control-plane network that has no default external route.
7. Authorized Luna and Terra deployment names plus the matching provider credentials are available for a controlled scan; the fallback model is also configured and tested.
8. Egress policy, DNS pinning/proxying, logs, alerts, and recovery ownership are defined. Backup and restore are explicitly deferred for the current no-full-scan invite-only beta; they remain required before general availability, any RPO/RTO claim, or broad scan availability. If threat enrichment is enabled, permit bounded HTTPS access to the CISA KEV JSON feed and FIRST EPSS API.

## Full-scan resource checklist

The live Lite Scanner is a separate passive API and cannot be promoted into the full worker by configuration alone. A controlled repository scan requires all of the following:

- migrated PostgreSQL for application and scan state;
- a private/TLS `redis://` or `rediss://` service compatible with BullMQ and reachable by both web and worker—Upstash REST URL/token variables are for rate limiting and do not replace `REDIS_URL`;
- a deployed authenticated Next.js application origin to create targets, authorize users, enqueue scans, and render retained results;
- dedicated worker compute with Git, the `lyrashield` CLI, the inspected engine source, controlled access to the digest-pinned sandbox runtime, and a dedicated internal network shared only with scan sandboxes;
- an authorized Luna/Terra/fallback model route and provider credentials;
- private S3-compatible evidence storage configured through all five `S3_*` values;
- secret management, TLS, monitoring, deployment-level egress enforcement, and backup/restore before general availability.

The initial invite-only beta uses password/OAuth access without email verification, so Brevo is not required for sign-up. Set `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="1"` only after Brevo and a verified sender are configured; password reset remains unavailable until then. GitHub App credentials are required for private-repository integration flows. Slack/Discord, billing, and product analytics are optional integrations and are not scan-runtime dependencies.

## Required application configuration

Set the production values appropriate to the selected infrastructure:

```bash
DATABASE_URL="postgresql://..."
DATABASE_DIRECT_URL="postgresql://..." # direct migration connection when using a pooler
REDIS_URL="rediss://..."
BETTER_AUTH_SECRET="..."
BETTER_AUTH_URL="https://app.example.com"
NEXT_PUBLIC_APP_URL="https://app.example.com"
NEXT_PUBLIC_MARKETING_URL="https://www.example.com"
BETTER_AUTH_COOKIE_DOMAIN=".example.com" # only when app and marketing share a parent domain
ADDITIONAL_TRUSTED_ORIGINS="https://www.example.com"
TRUSTED_PROXY_IP_HEADER="x-forwarded-for" # only after ingress strips incoming copies

# Email (optional during the initial no-email-verification beta)
LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="0"
BREVO_API_KEY="..."
EMAIL_FROM="noreply@example.com"

# Optional OAuth sign-in. Register these exact production callback paths:
# https://<app-origin>/api/auth/callback/github
# https://<app-origin>/api/auth/callback/google
# https://<app-origin>/api/auth/callback/microsoft
# The invite-only beta accepts OAuth only for existing invited users;
# missing or partial credentials leave the corresponding button disabled.
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
LYRASHIELD_WORKER_CONCURRENCY="1" # beta: one active sandboxed scan
LYRASHIELD_BETA_INVITE_EMAILS="founder@example.com,approved-beta@example.com"
PLATFORM_MAX_SCAN_BUDGET_USD="50"
LYRASHIELD_TELEMETRY="0"

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
| GPT-5.6 Sol   | $5.00 |             $0.50 |       $6.25 | $30.00 |
| GPT-5.6 Terra | $2.50 |             $0.25 |      $3.125 | $15.00 |
| GPT-5.6 Luna  | $1.00 |             $0.10 |       $1.25 |  $6.00 |

Source: OpenAI's official GPT-5.6 announcement and pricing, captured with its effective date. Cache writes are 1.25 times the uncached input rate. Requests whose prompts exceed 272,000 tokens use the official long-context multipliers of 2 times input and 1.5 times output. The parser assigns complete request entries to standard or long-context input/cache-write/cache-read/output buckets; aggregate counters that cannot identify which request crossed the boundary are not estimated locally.

`LYRASHIELD_LLM` is mandatory as the backward-compatible fallback when a routed variable is absent or empty. Azure deployment names are operator-defined: if the Azure deployment is not literally named `gpt-5.6-luna` or `gpt-5.6-terra`, put the real deployment name after `azure/` or `azure_ai/`.

A finite positive `Policy.maxBudgetUsd` overrides the default for that scan. Zero, negative, non-finite, missing, deleted, or cross-workspace policy values cannot remove the mode cap. The worker records `engine_start` with coordinator model/reasoning and retains accounting events privately. When the engine returns usage, the ledger retains provider telemetry, actual-model per-request buckets, the official rate-card calculation, calculation method, reconciliation status, request count, and normalized token counters. A numeric internal bill is written only when that rate-card amount is fully determined and agrees with provider-reported cost when one exists. Ambiguous long-context aggregates, missing billable dimensions, and mismatches remain unpriced and explicitly unreconciled; they do not turn a valid scan result into a fake failure. It never stores prompts or raw provider request payloads, and the dashboard renders no cost, spend, cap, or accounting-event value.

These amounts are internal hard ceilings, not expected per-scan charges or user-facing prices. Engine-reported telemetry is retained for reconciliation even when it exceeds the approved ceiling; an unpriced or capped internal ledger cannot be presented as the provider invoice. Reconcile it against the Azure meter during the controlled gate; Azure billing remains the final expenditure source.

A durable scan event is recorded immediately before a repository scan enters the provider-billable engine phase. Preflight work remains retryable, while recovery after that boundary fails closed instead of replaying provider work; a failed billable invocation requires an explicit new scan or retest so the queue cannot silently duplicate model spend. Deterministic SCA, secret, URL, and agent-configuration findings use the Safe profile for targeted retests; engine-only findings retain their originating review depth.

Safe/Quick/Standard are Luna-only. Deep/Custom use a deterministic two-tier invocation: Terra/medium is the root coordinator and Luna/medium handles child specialist work. The model cannot self-promote a child to Terra, and only the root can create or stop specialists.

Engine PRs #6 and #7 are merged. The promoted engine compacts estimated input at 240k toward 180k, bounds direct dedupe input to 200 kB, limits output and agent concurrency, and reserves projected spend before each request. These controls do not replace provider-meter reconciliation or prove finding quality.

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

1. Deploy all 21 migrations before application processes serve traffic, including `20260713170000_scorecard_events`, `20260714170000_integration_global_external_id_unique`, `20260716150000_integration_external_id_check`, `20260716151000_scorecard_share_active_snapshot_unique`, and `20260718110000_scan_cost_ledger`; run the migration-diff gate against a fresh shadow database.
2. Verify `/api/health`, `/api/ready`, `/api/ready/scans`, authentication, workspace isolation, Redis queue connectivity, and worker readiness. The scan-specific endpoint must become `503` within 30 seconds of stopping every worker and recover only after a BullMQ-ready worker registers its lease.
3. Verify the engine version and missing-model early-exit path.
4. Run a Safe or Standard controlled scan and verify its `engine_start` event names Luna with medium reasoning and its `budget_cap` event contains the expected default or policy amount.
5. Run a founder-approved Deep controlled scan and verify its `engine_start` event names Terra with medium reasoning and its cap is $15 or the selected positive policy override.
6. Capture audit evidence, confirm the sandbox image digest used, reconcile provider billing with the retained usage/rate-card ledger without treating it as an invoice, and verify evidence artifacts are retrievable from the configured S3-compatible endpoint. Any placeholder or failed upload blocks the gate.
7. Backup and restore are deferred by founder decision for the current no-full-scan beta. Do not claim an RPO/RTO or expand to general availability until an isolated restore drill passes.
8. Confirm URL targets use only the pinned deterministic URL scanner. Do not re-enable the external engine for URL targets until its transport is DNS-pinned and redirect-safe.
9. Confirm GitHub callbacks can refresh only a pre-existing workspace binding. Fresh installation claims and client-authored Fix PR payloads must remain blocked until their provider-ownership and server-generated-patch gates are implemented.

Queue recovery is deliberately fail-closed. Workers reconcile queue/database drift at startup and every 60 seconds under a renewable token-owned Redis lease. An active scan (`QUEUED`, `PREFLIGHT`, `RUNNING`, or `VERIFYING`) stale for more than five minutes without a processable job becomes `FAILED` with `QUEUE_ORPHANED`; operators must not automatically requeue it because the original attempt may have crossed a paid-provider boundary.

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

### Current production-beta deployment status — 2026-07-20

- `https://lyrashieldai.com` is live on the `lyrashield-marketing` Worker. The apex and `www` custom domains are attached.
- `https://app.lyrashieldai.com` is live as the separate invite-only authenticated beta. Password and configured OAuth access are available without email verification; password reset remains unavailable until an email provider is configured.
- Production D1, Rate Limit, and KV bindings are provisioned; migrations `0001`–`0003` are applied remotely; `WAITLIST_IP_SALT` is stored as a Worker secret.
- `PUBLIC_SITE_URL=https://lyrashieldai.com` and `PUBLIC_INDEXABLE=true`. The marketing, methodology, browser-local tools, and passive `/scan` surface are indexable. `/terms` remains page-scoped `noindex` and excluded from the sitemap.
- Live HTTPS, security headers, canonical/schema metadata, sitemap/robots/`llms.txt`, waitlist behavior, representative Lighthouse/Brave rendering, the permanent path/query-preserving `www`-to-apex redirect, and a production browser Lite Check pass.
- Production sets `PUBLIC_SCANNER_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, and `PUBLIC_ABUSE_EMAIL` together because the separately protected scanner API and monitored abuse workflow are live. Keep all three configured as one availability gate. `PUBLIC_APP_URL` remains independent and intentionally unset on marketing because the beta app is not yet linked as a public destination.

Before deploying the Cloudflare marketing Worker:

1. Replace the D1 database ID and Rate Limit namespace placeholder in `apps/marketing/wrangler.jsonc`.
2. Apply all D1 migrations in `apps/marketing/migrations/` (including `0003_waitlist_referrals.sql`, which adds the waitlist referral columns) with `wrangler d1 migrations apply` before serving traffic.
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
- A green application CI run is not evidence of configured production secrets, DNS, billing, or recovery readiness.
- A database uniqueness migration passing on an empty environment is not evidence that legacy duplicate provider bindings were reconciled.
