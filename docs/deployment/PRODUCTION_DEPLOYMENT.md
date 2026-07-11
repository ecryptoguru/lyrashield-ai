# LyraSec AI — Production Deployment Gate

> No production deployment is approved by this document. It records the minimum gates that must be satisfied before a release. Choose vendors and infrastructure only after founder approval; do not copy local Docker Compose into production.

## Architecture boundary

- The Next.js web application and BullMQ worker need managed PostgreSQL and Redis.
- The worker runs the `lyrashield` CLI and may launch a sandbox. Its host and Docker access are high-risk infrastructure.
- The Astro marketing site is an independent Cloudflare Worker with D1 and Cloudflare Rate Limits.
- Evidence storage, email, GitHub OAuth/App integration, and monitoring are optional integrations with separate credentials.

## Release prerequisites

1. A public HTTPS application origin and all trusted auth origins are decided.
2. Production Postgres migrations and the CI migration-drift check pass.
3. Redis is private/TLS-protected and reachable by both web and worker.
4. All secrets are supplied through the platform's secret manager, never committed files.
5. The worker runs as a dedicated non-root user with least-privilege filesystem and Docker access.
6. The sandbox image is pinned to an inspected digest; mutable tags are not acceptable.
7. Authorized `LYRASHIELD_LLM` and `LLM_API_KEY` values are available for a controlled scan.
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
ADDITIONAL_TRUSTED_ORIGINS="https://www.example.com"

LYRASHIELD_LLM="provider/model"
LLM_API_KEY="..."
LYRASHIELD_ENGINE_PATH="lyrashield"
LYRASHIELD_IMAGE="ghcr.io/usestrix/strix-sandbox@sha256:<approved-digest>"
LYRASHIELD_TELEMETRY="0"
```

Add GitHub OAuth/App, R2/S3, email, notification, billing, and monitoring variables only when those integrations are enabled. Use `.env.example` as the complete variable index, not as a production secret file.

## Verification before release

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Then, in the target environment:

1. Deploy migrations before application processes serve traffic.
2. Verify authentication, workspace isolation, Redis queue connectivity, and Worker readiness.
3. Verify the engine version and missing-model early-exit path.
4. Run one founder-authorized controlled scan. Capture audit evidence and confirm the sandbox image digest used.
5. Exercise backup and restore on non-production data before claiming an RPO/RTO.

## Marketing deployment

Before deploying the Cloudflare marketing Worker:

1. Replace the D1 database ID and Rate Limit namespace placeholder in `apps/marketing/wrangler.jsonc`.
2. Set `WAITLIST_IP_SALT` with `wrangler secret put`; do not retain the example value.
3. Build with the intended public origin. `PUBLIC_INDEXABLE=true` is rejected unless `PUBLIC_SITE_URL` is public HTTPS.
4. Deploy using Astro's generated configuration:

```bash
PUBLIC_SITE_URL="https://www.example.com" PUBLIC_INDEXABLE=true \
  pnpm --filter @lyrashield/marketing build
pnpm --filter @lyrashield/marketing exec wrangler deploy --config dist/server/wrangler.json
```

5. On the live domain, verify the waitlist submission, canonical URL, Open Graph image, JSON-LD, `robots.txt`, sitemap, and HTTPS redirect. Do not enable indexing until visual QA and founder approval are complete.

## Do not claim as verified

- Docker image build or container health is not a sandbox-scan test.
- A local noindex marketing preview is not a live SEO verification.
- A green application CI run is not evidence of configured production secrets, DNS, billing, or backups.
