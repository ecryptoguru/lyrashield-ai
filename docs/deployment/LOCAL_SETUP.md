# LyraShield AI — Local Setup

This guide covers local development only. `docker-compose.yml` binds services to localhost and mounts Docker for sandbox work; it is not a production deployment file.

## Prerequisites

- Node.js 20+ and pnpm 11
- Docker Desktop / Docker Engine
- Git
- `uv` only when developing the sibling engine repository

Keep the platform and engine repositories next to each other:

```text
~/Desktop/lyrashield-ai
~/Desktop/lyrashield-engine
```

## 1. Configure the platform

```bash
cd ~/Desktop/lyrashield-ai
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

The current source suite is 625 Vitest tests in 56 files plus 2 Chromium E2E tests; treat command output, not a hard-coded count, as authoritative. Playwright uses an isolated production preview on `127.0.0.1:3100`.

## 4. Run the marketing site

```bash
cd ~/Desktop/lyrashield-ai
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

## 5. Build the worker image and engine

```bash
cd ~/Desktop/lyrashield-ai
docker compose build worker
docker compose up -d worker
docker compose exec worker lyrashield --version
```

The worker image consumes the sibling engine source through its named Docker build context. It exits before sandbox setup if `LYRASHIELD_LLM` or `LLM_API_KEY` is missing.

For Azure OpenAI, use the `azure/` prefix and endpoint or the Azure-specific variables:

```bash
LYRASHIELD_LLM="azure/gpt-5.6-terra"
LLM_API_KEY="<azure-key>"
LLM_API_BASE="https://<resource>.openai.azure.com"
# Optional:
LLM_API_VERSION="v1"
```

Or:

```bash
LYRASHIELD_LLM="azure/gpt-5.6-terra"
AZURE_OPENAI_API_KEY="<azure-key>"
AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com"
AZURE_API_VERSION="v1"
```

For Azure AI project / serverless endpoints, use the `azure_ai/` prefix with the **inference base URL** (not the project API path):

```bash
LYRASHIELD_LLM="azure_ai/gpt-5.6-terra"
AZURE_AI_API_KEY="<azure-key>"
AZURE_AI_API_BASE="https://<resource>.services.ai.azure.com"
# Optional:
AZURE_API_VERSION="v1"
```

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
cd ~/Desktop/lyrashield-ai
docker compose up --build -d
docker compose ps
curl -fsS http://localhost:3000/ >/dev/null
docker compose down
```

`BETTER_AUTH_SECRET` must be set before this command. Docker health does not prove that a sandbox scan executed.

## Troubleshooting

- If a local port is occupied, stop the existing process rather than changing application configuration.
- If Prisma reports drift, run the migration checks; do not use `db:push` as a production repair.
- If the worker cannot find `lyrashield`, confirm the sibling repository path or `LYRASHIELD_ENGINE_SOURCE` before rebuilding.
- If the waitlist returns 500 locally, set a non-placeholder `WAITLIST_IP_SALT` in `apps/marketing/.dev.vars`.
