# LyraShield AI — Local Setup

This guide covers local development only. `docker-compose.yml` binds services to localhost and mounts Docker for sandbox work; it is not a production deployment file.

## Prerequisites

- Node.js 24 and pnpm 11
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

**Redis architecture:** `REDIS_URL` (redis://) is reserved for the BullMQ job queue. In local development it points to the Docker Compose Redis service. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (HTTPS REST) are for distributed rate limiting via `@upstash/ratelimit` in production only — leave them blank in dev to use the in-memory limiter. The two are never interchangeable. Docker Compose does not pass Upstash env vars to web/worker services; rate limiting falls back to in-memory in dev.

Optional auth/worker toggles in `.env`:

- `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` — set to `1` to require verified email before sign-in. Requires `BREVO_API_KEY`, `EMAIL_FROM`, and `NOTIFICATION_FROM_EMAIL` to send verification and password-reset emails. A Brevo API key is provisioned and verified locally; Brevo IP security is disabled at the account level because production Azure Container Apps has dynamic outbound NAT IPs. See `docs/deployment/PRODUCTION_DEPLOYMENT.md` §1.
- `LYRASHIELD_WORKER_CONCURRENCY` — BullMQ worker concurrency (default `1`).

The web app expects `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_MARKETING_URL` (and optionally `PORT`) in `apps/web/.env`:

```bash
cp apps/web/.env.example apps/web/.env
```

Next.js production builds read required values from `process.env`; the root `.env` is not loaded automatically for page-data collection. Before `pnpm build`, either export the required variables or copy the local file for the web app:

```bash
cp .env apps/web/.env
```

The dashboard can run without evidence storage, but any scan that produces PoC or code-location evidence requires `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_REGION`. Evidence persistence fails closed when these values are absent or upload fails.

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

Treat current command output, not a hard-coded test count, as authoritative. Playwright uses an isolated production preview on `127.0.0.1:3100`.

### Use the CLI

The CLI package (`packages/cli`) builds from the same monorepo. With the local web app running, you can use it against `http://localhost:3001`:

```bash
cp .env apps/web/.env
pnpm --filter @lyrashield/cli build
npx @lyrashield/cli login        # OAuth device flow (browser) or LYRASHIELD_API_KEY from env
npx @lyrashield/cli use <workspace>
```

Or run it from the workspace root:

```bash
npx lyrashield --help
npx lyrashield doctor
npx lyrashield scan --target <targetId> --goal TEST_APP
```

For the full command catalog, exit codes, and environment variables, see `packages/cli/README.md`.

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

That preview is intentionally noindex. It should return 200 for `/`, `/robots.txt`, and `/sitemap-index.xml`, and 404 for `/llms.txt` because that build is not indexable.

Open the local app, sign up for a new account, and complete onboarding. Any email works — registration is open, with no invitation step. The `waitlist` endpoint (the optional product-updates subscription backend) remains available for the homepage referral flow if still configured.

## 5. Build the worker image and engine

```bash
cd ~/Desktop/lyrashieldai
docker compose build worker
docker compose up -d web worker
docker compose exec worker lyrashield --version
curl -fsS http://localhost:3000/api/ready/scans
```

The worker image consumes the sibling engine source through its named Docker build context. Compose also creates the internal `lyrashield-sandbox` network shared by the worker and its dynamically created scan sandboxes. This network is required for the worker-to-Caido control plane and has no default external route. The worker exits before accepting scans if the resolved model, selected provider credential, or sandbox network name is missing.

The web app accepts a scan only while a worker heartbeat is live. Workers refresh their Redis lease every two minutes and it expires after five minutes following a crash or lost Redis connection. Heartbeat registration and readiness are each one-key Lua operations; the separate admission-stop key uses `EXISTS` so Redis Cluster does not receive a cross-slot script. `/api/ready/scans` returns `503` while no worker is available, and the UI asks the user to retry instead of leaving a scan permanently queued.

The worker reconciles queue/database drift unconditionally at startup. Its five-minute timer reconciles when the database has nonterminal scans, otherwise it performs an hourly idle backstop; a database-read failure runs the normal reconciliation fail-safe. A database scan that remains `QUEUED` for five minutes without a processable BullMQ job fails closed as `QUEUE_ORPHANED`; it is never re-enqueued automatically because that could repeat paid model work. Do not delete BullMQ keys or jobs directly in Redis. Remove a queued job only through an application/operator flow that also transitions its database scan to `CANCELLED` or `FAILED` and records a scan event.

Exercise the readiness transition without creating a scan:

```bash
docker compose stop worker
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/ready/scans # 503
docker compose up -d worker
curl -fsS http://localhost:3000/api/ready/scans # ready after registration
```

Use the dashboard/API cancellation action for queued or running scans. Never remove a Redis job directly: cancellation owns the database transition and event, active phases observe it, and reconciliation removes a remaining non-active job.

The base `LYRASHIELD_LLM` is the fallback. During worker scans, Safe/Quick/Standard use `LYRASHIELD_LUNA_LLM` at medium reasoning. Deep/Custom use `LYRASHIELD_TERRA_LLM` at medium for the coordinator and `LYRASHIELD_LUNA_LLM` at high for focused child specialists. The values after `azure/` or `azure_ai/` must be the real Azure deployment names.

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

### Web Search (Parallel Search)

The engine can call Parallel Search for real-time OSINT during repository scans. This is independent of the model provider above.

```bash
# Set to 1 only after adding a real key below
LYRASHIELD_WEB_SEARCH_ENABLED="0"
LYRASHIELD_WEB_SEARCH_API_KEY="<parallel-search-api-key>"
# Optional:
LYRASHIELD_WEB_SEARCH_MODE="turbo"           # turbo | basic | advanced
LYRASHIELD_WEB_SEARCH_MAX_RESULTS="5"        # 1-20
LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL="4000" # 1000-20000
LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN="50"
LYRASHIELD_WEB_SEARCH_BUDGET_USD="1.0"       # separate web-search cap
```

Keep `LYRASHIELD_WEB_SEARCH_ENABLED="0"` unless the key is configured. When enabled, the engine redacts target hostnames, secrets, and PII from the search query before it leaves the worker and tracks each call against the scan's web-search budget. No mode is gated today; the tool is available to all scan modes while you evaluate which ones benefit.

Repository profiles are defined once in `packages/types/src/scan-profile.ts`:

| Product mode                     | AI route                               | Budget ceiling | Typical estimate |
| -------------------------------- | -------------------------------------- | -------------: | ---------------: |
| Quick / Safe compatibility alias | Luna, medium                           |          $1.20 |           15 min |
| Standard                         | Luna, medium                           |          $3.20 |           15 min |
| Deep / Custom                    | Terra, medium + Luna, high specialists |          $5.00 |           45 min |

The repository estimates are not elapsed-time termination limits: an engine continues while its bounded `run.json` receipt advances. It still stops on user cancellation, its protected provider budget, or 20 minutes without durable receipt progress. A finite positive workspace `Policy.maxBudgetUsd` may lower the selected provider budget but cannot raise it; an explicit zero budget fails closed. `Policy.maxDurationMinutes` continues to bound deterministic URL/API profiles, which have their own request and egress limits and no AI model or AI budget.

The dashboard names these modes Release Check (Quick), Code Review (Standard), and Deep Security Review (Deep); Weekly Monitor schedules use Quick. Safe is a compatibility alias for Quick. URL/API targets skip the external engine. Model cost, spend, cap, and accounting events remain private and are not rendered in the dashboard. See `userguide.md` for the user-facing option matrix and `PRODUCTION_DEPLOYMENT.md` for the operator rate card.

Routing verification without printing credentials:

```bash
docker compose exec worker sh -lc \
  'test -n "$LYRASHIELD_LLM" && test -n "$LYRASHIELD_LUNA_LLM" && test -n "$LYRASHIELD_TERRA_LLM"'
```

After an authorized scan, inspect its timeline and confirm:

- Safe/Quick/Standard: `engine_start` reports Luna and `medium`; `budget_cap` reports $1.20/$1.20/$3.20 respectively unless lowered by policy.
- Deep/Custom: `engine_start` reports the Terra/medium coordinator; the run artifact records Luna/high delegates and the versioned routing policy; `budget_cap` reports $5 unless lowered by policy. On a root content-filter block, the engine switches directly to Luna/high without retrying Terra.
- `llm_usage` is present when the provider returned usage data.
- When request entries are complete, `llm_usage` records `pricingMethod: per_request_buckets` and separates standard/long-context input, cached reads, cache writes, and output. Aggregate-only input above 272,000 tokens remains unavailable instead of being guessed.

Deep/Custom use deterministic tiering rather than model-selected promotion: Terra coordinates and judges cross-file evidence, while Luna/high executes focused specialist tasks. Only the root can create or stop specialists, preventing recursive child fan-out. Safe/Quick/Standard remain Luna-only at medium reasoning.

Supported GPT-5.6 routes enable prompt caching by default. Stable role-specific cache keys keep reusable prompt prefixes aligned across coordinator and delegate calls. Verify `run.json` and private usage events retain separate cache-read and cache-write token counters; absence of provider bucket detail must remain explicitly unreconciled.

The worker runs a bounded stale-resource reaper by default every 15 minutes with a 24-hour minimum age. It skips running containers and every scan in `QUEUED`, `PREFLIGHT`, `RUNNING`, or `VERIFYING`; a database ownership-read failure skips cleanup entirely. Never use broad Docker prune or recursive host cleanup as a substitute.

Engine PRs #6, #7, and #20 are merged. Current engine behavior compacts estimated input at 240,000 tokens toward about 180,000 tokens, bounds direct dedupe input to 200 kB, limits output/agent concurrency, reserves projected spend before each request, and correctly extracts usage tokens from dict or object entries with provider-reported cache-read accounting. The engine also falls back from Terra to Luna on any `ModelBehaviorError` (not just content filter), treats Azure's `response.failed` without filter context as transient (retried with backoff), and salvages partial findings with `engine_stopped` terminal reason when the delegate also fails. These are code/build guarantees; they do not prove result quality or replace provider-meter reconciliation.

For engine work on the host:

```bash
cd ~/Desktop/lyrashield-engine
uv sync --frozen
./scripts/verify-controlled-derivative.sh
```

The engine CI workflow now runs all of the above (ruff, mypy, bandit, pytest) on every PR and push to `main`. Pre-commit hooks remain for local feedback, but CI enforces the same gates — `--no-verify` is no longer a way to bypass quality checks.

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
- If the homepage waitlist endpoint returns 500 locally, set a non-placeholder `WAITLIST_IP_SALT` in `apps/marketing/.dev.vars`.

## Evidence envelope key (S3 evidence mode)

Local Compose uses the encrypted local evidence store
(`LYRASHIELD_LOCAL_EVIDENCE_STORAGE=1`, HKDF from `BETTER_AUTH_SECRET`) and
needs no extra key. If you point a local environment at S3-compatible evidence
storage instead, generate the required envelope key once:

```bash
node packages/evidence-storage/scripts/generate-kek.mjs
# → set as LYRASHIELD_EVIDENCE_KEK in .env (base64, exactly 32 bytes)
```

Uploads fail closed without it — that is the intended behavior, not a bug.
