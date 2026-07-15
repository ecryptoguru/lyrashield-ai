# LyraShield AI — Production Deployment Gate

> No production deployment is approved by this document. It records the minimum gates that must be satisfied before a release. Choose vendors and infrastructure only after founder approval; do not copy local Docker Compose into production.

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
6. The sandbox image is pinned to an inspected digest; mutable tags are not acceptable.
7. Authorized Luna and Terra deployment names plus the matching provider credentials are available for a controlled scan; the fallback model is also configured and tested.
8. Egress policy, DNS pinning/proxying, logs, alerts, backup, and restore ownership are defined.

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

# Email (required for email verification in production)
BREVO_API_KEY="..."
EMAIL_FROM="noreply@example.com"

LYRASHIELD_LLM="provider/fallback-model"
LYRASHIELD_LUNA_LLM="provider/gpt-5.6-luna"
LYRASHIELD_TERRA_LLM="provider/gpt-5.6-terra"
LLM_API_KEY="..."
LYRASHIELD_ENGINE_PATH="lyrashield"
LYRASHIELD_IMAGE="ghcr.io/usestrix/strix-sandbox@sha256:<approved-digest>"
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
| Deep         | deep        | `LYRASHIELD_TERRA_LLM` | high      |      $15.00 |
| Custom       | deep        | `LYRASHIELD_TERRA_LLM` | high      |      $15.00 |

`LYRASHIELD_LLM` is mandatory as the backward-compatible fallback when a routed variable is absent or empty. Azure deployment names are operator-defined: if the Azure deployment is not literally named `gpt-5.6-luna` or `gpt-5.6-terra`, put the real deployment name after `azure/` or `azure_ai/`.

A finite positive `Policy.maxBudgetUsd` overrides the default for that scan. Zero, negative, non-finite, missing, deleted, or cross-workspace policy values cannot remove the mode cap. The worker records `engine_start` with model/reasoning and `budget_cap` with amount/source; provider-reported `llm_usage` is recorded separately when returned by the engine.

These amounts are hard ceilings, not expected per-scan charges. Actual spend depends on provider token accounting and how early the scan completes; reconcile the retained usage event against the Azure meter during the controlled gate.

This is mode-level routing: a scan uses one model for its full engine invocation. It does not run Luna discovery followed by Terra validation inside the same scan.

Add GitHub OAuth/App, R2/S3, email, notification, billing, and monitoring variables only when those integrations are enabled. Use `.env.example` as the complete variable index, not as a production secret file.

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

1. Deploy all 17 migrations before application processes serve traffic, including `20260713170000_scorecard_events` and `20260714170000_integration_global_external_id_unique`; run the migration-diff gate against a fresh shadow database.
2. Verify `/api/health`, `/api/ready`, authentication, workspace isolation, Redis queue connectivity, and Worker readiness.
3. Verify the engine version and missing-model early-exit path.
4. Run a Safe or Standard controlled scan and verify its `engine_start` event names Luna with medium reasoning and its `budget_cap` event contains the expected default or policy amount.
5. Run a founder-approved Deep controlled scan and verify its `engine_start` event names Terra with high reasoning and its cap is $15 or the selected positive policy override.
6. Capture audit evidence, confirm the sandbox image digest used, reconcile provider billing with the retained `llm_usage` event, and verify evidence artifacts are retrievable from the configured S3-compatible endpoint. Any placeholder or failed upload blocks the gate.
7. Exercise backup and restore on non-production data before claiming an RPO/RTO.
8. Confirm URL targets use only the pinned deterministic URL scanner. Do not re-enable the external engine for URL targets until its transport is DNS-pinned and redirect-safe.
9. Confirm GitHub callbacks can refresh only a pre-existing workspace binding. Fresh installation claims and client-authored Fix PR payloads must remain blocked until their provider-ownership and server-generated-patch gates are implemented.

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
- `PUBLIC_SITE_URL=https://lyrashieldai.com` and `PUBLIC_INDEXABLE=true`. The ready marketing/methodology/browser-local-tools surface is indexable. `/scan` and `/terms` are page-scoped `noindex` and excluded from the sitemap.
- Live HTTPS, security headers, canonical/schema metadata, sitemap/robots/`llms.txt`, waitlist behavior, a 19-URL internal crawl, representative Lighthouse/Brave rendering, and the permanent path/query-preserving `www`-to-apex redirect pass.
- The scanner remains disabled because `PUBLIC_APP_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, and `PUBLIC_ABUSE_EMAIL` are intentionally unset. Set all three together only after the separately protected app API and abuse workflow are live.

Before deploying the Cloudflare marketing Worker:

1. Replace the D1 database ID and Rate Limit namespace placeholder in `apps/marketing/wrangler.jsonc`.
2. Apply all D1 migrations in `apps/marketing/migrations/` (including `0003_waitlist_referrals.sql`, which adds the waitlist referral columns) with `wrangler d1 migrations apply` before serving traffic.
3. Set `WAITLIST_IP_SALT` with `wrangler secret put`; do not retain the example value.
4. Build with the intended public origins. `PUBLIC_INDEXABLE=true` is rejected unless `PUBLIC_SITE_URL` is public HTTPS.
5. Deploy using Astro's generated configuration:

   ```bash
   PUBLIC_SITE_URL="https://lyrashieldai.com" \
   PUBLIC_APP_URL="https://app.example.com" \
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
