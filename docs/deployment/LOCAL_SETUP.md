# LyraShield AI — Local Setup

This guide covers local development only. `docker-compose.yml` binds services to localhost and mounts Docker for sandbox work; it is not a production deployment file.

## Prerequisites

- Node.js 20+ and pnpm 11
- Docker Desktop / Docker Engine
- Git
- `uv` only when developing the sibling engine repository

Keep the platform and engine repositories next to each other:

```text
~/Desktop/lyrashieldai
~/Desktop/lyrashield-engine
```

## 1. Configure the platform

```bash
cd ~/Desktop/lyrashieldai
cp .env.example .env
pnpm install --frozen-lockfile
```

Set a real local `BETTER_AUTH_SECRET` in `.env`. When using Compose, set `REDIS_URL` to the password-protected local endpoint shown in `.env.example`.

The web app expects `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_MARKETING_URL` (and optionally `PORT`) in `apps/web/.env`:

```bash
cp apps/web/.env.example apps/web/.env
```

Next.js production builds read required values from `process.env`; the root `.env` is not loaded automatically for page-data collection. Before `pnpm build`, either export the required variables or copy the local file for the web app:

```bash
cp .env apps/web/.env
```

The dashboard can run without evidence storage, but a scan worker requires durable evidence storage before it registers as ready: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_REGION`. Local development may explicitly use `LYRASHIELD_LOCAL_EVIDENCE_STORAGE=1` outside production. Evidence persistence fails closed when storage is absent or an upload fails; the worker does not accept scans it cannot retain.

## 2. Start Postgres and Redis

```bash
docker compose up -d postgres redis
docker compose ps
pnpm db:generate
pnpm --filter @lyrashield/db migrate:deploy
```

The local services listen only on `127.0.0.1:5432` and `127.0.0.1:6379`.

## 3. Run the platform

```bash
pnpm dev
```

The dashboard is available at `http://localhost:3001` (set `PORT` in `apps/web/.env` to change it). Before submitting a pull request, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
git diff --check
```

The merged PR #109 baseline passes 858 core tests in 94 files, 79 marketing tests in 12 files, 16 motion tests, and 2 Chromium E2E tests. Treat current command output, not a hard-coded count, as authoritative. Playwright uses an isolated production preview on `127.0.0.1:3100`.

### Verify scorecards and social sharing

Apply all PostgreSQL migrations first; `20260713170000_scorecard_events` is required for view/share recording. `20260714170000_integration_global_external_id_unique` intentionally rejects duplicate non-null provider installation IDs, so resolve disposable local duplicates before applying it rather than editing the migration. In the dashboard, complete or use an eligible Standard/Deep scan, publish its scorecard from the target page, and copy the generated slug.

For `SLUG=<generated-slug>`:

```bash
curl -fsS "http://localhost:3001/score/$SLUG" >/dev/null
curl -fsS "http://localhost:3001/api/og/score/$SLUG?variant=grade&format=wide" -o /tmp/score-wide.png
curl -fsS "http://localhost:3001/api/og/score/$SLUG?variant=fixes&format=square" -o /tmp/score-square.png
curl -fsS "http://localhost:3001/api/og/score/$SLUG?variant=fixes&format=portrait" -o /tmp/score-portrait.png
curl -fsSI "http://localhost:3001/api/badge/score/$SLUG"
```

Expected image dimensions are 1200×630, 1080×1080, and 1080×1350. In a browser, verify Grade/Verified fixes switching, responsive layout at 390px, the public conversion CTA, channel buttons, copy/download/badge controls, and a clear fallback when clipboard permission is denied. Revoking the share must make the page, all images, and the badge return 404.

Event checks must use the UI-generated random session identifier; do not invent a production analytics client. Reloading the same share in the same browser/day must not increment a second human `VIEW`. Enabling Do Not Track or Global Privacy Control should suppress client event emission.

## 4. Run the marketing site

```bash
cd ~/Desktop/lyrashieldai
cp apps/marketing/.env.example apps/marketing/.env
cp apps/marketing/.dev.vars.example apps/marketing/.dev.vars
pnpm --filter @lyrashield/marketing exec wrangler d1 migrations apply lyrashield-marketing-waitlist --local
pnpm --filter @lyrashield/marketing dev
```

Astro development serves at `http://localhost:4321`. To exercise the actual Worker/asset configuration instead, run:

```bash
pnpm --filter @lyrashield/marketing preview -- --port 8787
```

That preview is intentionally noindex. It should return 200 for `/`, `/robots.txt`, and `/sitemap-index.xml`, and 404 for `/llms.txt` before launch.

Submit a disposable local waitlist address and verify the success state shows queue position plus Copy/LinkedIn/X/WhatsApp referral actions. Reopening `/?ref=<returned-code>` and submitting a second disposable address should increment the first code's referral count without changing the API's non-leaking success shape.

## 5. Build the worker image and engine

```bash
cd ~/Desktop/lyrashieldai
docker compose build migrate web worker
docker compose up -d --force-recreate migrate
docker compose up -d web worker
docker compose exec worker lyrashield --version
curl -fsS http://localhost:3000/api/ready/scans
```

The worker image consumes the sibling engine source through its named Docker build context. It exits before sandbox setup if the resolved model or selected provider credential is missing.

The web app accepts a scan only while a worker heartbeat is live. Workers refresh their Redis lease every 10 seconds; the lease expires after 30 seconds following a crash or lost Redis connection. `/api/ready/scans` returns `503` while no worker is available, and the UI asks the user to retry instead of leaving a scan permanently queued.

The worker reconciles queue/database drift at startup and every minute. An active database scan (`QUEUED`, `PREFLIGHT`, `RUNNING`, or `VERIFYING`) stale for five minutes without a processable BullMQ job fails closed as `QUEUE_ORPHANED`; it is never re-enqueued automatically because that could repeat paid model work. Do not delete BullMQ keys or jobs directly in Redis. Remove a queued job only through an application/operator flow that also transitions its database scan to `CANCELLED` or `FAILED` and records a scan event.

Exercise the readiness transition without creating a scan:

```bash
docker compose stop worker
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/ready/scans # 503
docker compose up -d worker
curl -fsS http://localhost:3000/api/ready/scans # ready after registration
```

Use the dashboard/API cancellation action for queued or running scans. Never remove a Redis job directly: cancellation owns the database transition and event, active phases observe it, and reconciliation removes a remaining non-active job.

The base `LYRASHIELD_LLM` is the fallback. During worker scans, Safe/Quick/Standard use `LYRASHIELD_LUNA_LLM` at medium reasoning; Deep/Custom use `LYRASHIELD_TERRA_LLM` at high. The values after `azure/` or `azure_ai/` must be the real Azure deployment names.

For Azure OpenAI, use the `azure/` prefix and endpoint or the Azure-specific variables:

```bash
LYRASHIELD_LLM="azure/gpt-5.6-terra"
LYRASHIELD_LUNA_LLM="azure/gpt-5.6-luna"
LYRASHIELD_TERRA_LLM="azure/gpt-5.6-terra"
LLM_API_KEY="<azure-key>"
LLM_API_BASE="https://<resource>.openai.azure.com"
# Optional:
LLM_API_VERSION="v1"
```

Or:

```bash
LYRASHIELD_LLM="azure/gpt-5.6-terra"
LYRASHIELD_LUNA_LLM="azure/gpt-5.6-luna"
LYRASHIELD_TERRA_LLM="azure/gpt-5.6-terra"
AZURE_OPENAI_API_KEY="<azure-key>"
AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com"
AZURE_API_VERSION="v1"
```

For Azure AI project / serverless endpoints, use the `azure_ai/` prefix with the **inference base URL** (not the project API path):

```bash
LYRASHIELD_LLM="azure_ai/gpt-5.6-terra"
LYRASHIELD_LUNA_LLM="azure_ai/gpt-5.6-luna"
LYRASHIELD_TERRA_LLM="azure_ai/gpt-5.6-terra"
AZURE_AI_API_KEY="<azure-key>"
AZURE_AI_API_BASE="https://<resource>.services.ai.azure.com"
# Optional:
AZURE_API_VERSION="v1"
```

Default spend limits are $1.20 for Safe/Quick, $3.20 for Standard, and $15 for Deep/Custom. A finite positive workspace `Policy.maxBudgetUsd` overrides the mode amount. The worker passes the resolved amount through `--max-budget-usd`; invalid or missing policy values fall back to the mode limit.

The dashboard names these modes Release Check (Safe), Code Review (Standard), and Deep Security Review (Deep); Weekly Monitor schedules use Safe. URL/API targets skip the external engine. Model cost, spend, cap, and accounting events remain private and are not rendered in the dashboard. See `userguide.md` for the user-facing option matrix and `PRODUCTION_DEPLOYMENT.md` for the operator rate card.

Routing verification without printing credentials:

```bash
docker compose exec worker sh -lc \
  'test -n "$LYRASHIELD_LLM" && test -n "$LYRASHIELD_LUNA_LLM" && test -n "$LYRASHIELD_TERRA_LLM"'
```

After an authorized scan, inspect its timeline and confirm:

- Safe/Quick/Standard: `engine_start` reports Luna and `medium`; `budget_cap` reports $1.20/$3.20 unless policy-overridden.
- Deep/Custom: `engine_start` reports Terra and `high`; `budget_cap` reports $15 unless policy-overridden.
- `llm_usage` is present when the provider returned usage data.
- When request entries are complete, `llm_usage` records `pricingMethod: per_request_buckets` and separates standard/long-context input, cached reads, cache writes, and output. Aggregate-only input above 272,000 tokens remains unavailable instead of being guessed.

One scan uses one selected model. A Luna-to-Terra cascade inside one scan is not implemented.

Engine PRs #6 and #7 are merged. Current engine behavior compacts estimated input at 240,000 tokens toward about 180,000 tokens, bounds direct dedupe input to 200 kB, limits output/agent concurrency, and reserves projected spend before each request. These are code/build guarantees; they do not prove result quality or replace provider-meter reconciliation.

For engine work on the host:

```bash
cd ~/Desktop/lyrashield-engine
uv sync --frozen
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

Do not merge Strix upstream or run mechanical rebranding commands locally. Use the engine repository's review-only upstream-sync workflow, inspect the generated PR, and merge it normally after its checks pass.

## 6. Full Docker smoke

```bash
cd ~/Desktop/lyrashieldai
docker compose up --build -d
docker compose ps
curl -fsS http://localhost:3000/ >/dev/null
docker compose down
```

`BETTER_AUTH_SECRET` must be set before this command. Docker health does not prove that a sandbox scan executed.

## Troubleshooting

- If a local port is occupied, stop the existing process rather than changing application configuration.
- If Prisma reports drift, run the migration checks; do not use `db:push` as a production repair.
- If a database applied the first local draft of `20260713170000_scorecard_events`, its unique index may end in `dayBucket_`; current schema truth ends in `dayBuc_key`. Fresh databases are correct. For an old disposable local database, reset/redeploy migrations or rename only that index after confirming the exact drift—never edit an already-deployed production migration ad hoc.
- If the worker cannot find `lyrashield`, confirm the sibling repository path or `LYRASHIELD_ENGINE_SOURCE` before rebuilding.
- If the waitlist returns 500 locally, set a non-placeholder `WAITLIST_IP_SALT` in `apps/marketing/.dev.vars`.
