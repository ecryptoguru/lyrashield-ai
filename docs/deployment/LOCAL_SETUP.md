# LyraShield — Local Development Setup

## Prerequisites

```txt
Docker Desktop (or OrbStack) — for Postgres, Redis, and scan sandbox
Node.js 20+ (via nvm)
pnpm 11+
Python 3.12+ (only if developing the engine locally)
uv (Python package manager — only for engine development)
```

## Architecture Overview (Local)

```
┌─────────────────────────────────────────────────────┐
│  Host Machine (your Mac)                            │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Next.js Web │  │ TS Worker    │  │ LyraShield │ │
│  │ :3000       │  │ (tsx watch)  │  │ Engine CLI │ │
│  │             │  │              │  │ (Python)   │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                │                 │        │
│         │     ┌──────────┴──────────┐      │        │
│         │     │  Docker Compose     │      │        │
│         │     │                     │      │        │
│         ├────►│  Postgres :5432     │      │        │
│         ├────►│  Redis :6379        │      │        │
│         │     └─────────────────────┘      │        │
│         │                                  │        │
│         │     ┌─────────────────────┐      │        │
│         │     │  Sandbox Container  │◄─────┘        │
│         │     │  (Kali + tools)     │               │
│         │     │  Engine runs here   │               │
│         │     └─────────────────────┘               │
│         │                                           │
│         │     ┌─────────────────────┐               │
│         └────►│  MinIO :9000        │ (S3-compatible│
│               │  (evidence storage) │  object store) │
│               └─────────────────────┘               │
└─────────────────────────────────────────────────────┘
```

## Step-by-Step Setup

### 1. Clone Both Repos

```bash
# Platform (TypeScript monorepo)
git clone https://github.com/ecryptoguru/lyrasec-ai.git ~/Desktop/lyrasec-ai
cd ~/Desktop/lyrasec-ai

# Engine (Python fork)
git clone <your-github>/lyrashield-engine.git ~/Desktop/lyrashield-engine
```

### 2. Start Infrastructure (Docker Compose)

```bash
cd ~/Desktop/lyrasec-ai

# Start Postgres + Redis (+ MinIO for evidence storage)
docker compose up -d

# Verify
docker ps
# Should see: lyrashield-postgres (healthy), lyrashield-redis (healthy)
```

### 3. Configure Environment

```bash
cd ~/Desktop/lyrasec-ai
cp .env.example .env

# Edit .env — minimum required values:
# DATABASE_URL=postgresql://lyrashield:lyrashield@localhost:5432/lyrashield
# REDIS_URL=redis://localhost:6379
# BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
# BETTER_AUTH_URL=http://localhost:3000
# NEXT_PUBLIC_APP_URL=http://localhost:3000
#
# # Engine (for Sprint 5+)
# LYRASHIELD_ENGINE_PATH=~/Desktop/lyrashield-engine
# LYRASHIELD_LLM=openai/gpt-4o
# LLM_API_KEY=your-openai-key
#
# # GitHub OAuth (create at https://github.com/settings/developers)
# GITHUB_CLIENT_ID=your-client-id
# GITHUB_CLIENT_SECRET=your-client-secret
#
# # GitHub App (for repo scanning — Sprint 3)
# # Create at https://github.com/settings/apps
# GITHUB_APP_ID=your-app-id
# GITHUB_APP_PRIVATE_KEY=<contents-of-pem-file>
# GITHUB_WEBHOOK_SECRET=<generate-strong-secret>
```

### 4. Install Dependencies & Run Migrations

```bash
cd ~/Desktop/lyrasec-ai

# Install all workspace dependencies
pnpm install

# Generate Prisma client
pnpm db:generate

# Run database migrations
pnpm db:migrate

# (Optional) Seed database
pnpm db:seed
```

### 5. Start the Platform

```bash
cd ~/Desktop/lyrasec-ai

# Starts both web (:3000) and worker (stub mode)
pnpm dev
```

Verify:
- Web app: http://localhost:3000
- Sign up / sign in works
- Dashboard loads

### 6. Set Up the Scan Engine

Docker Compose builds the engine from the sibling Desktop repository into the worker image. Keep both repositories next to each other:

```text
~/Desktop/lyrasec-ai
~/Desktop/lyrashield-engine
```

Build and verify the integrated worker:

```bash
cd ~/Desktop/lyrasec-ai
docker compose build worker
docker compose up -d worker
docker compose exec worker lyrashield --version
```

For direct engine development on the host:

```bash
cd ~/Desktop/lyrashield-engine

uv sync --frozen
uv run lyrashield --help
```

Set `LYRASHIELD_ENGINE_SOURCE` only when the sibling engine repository lives somewhere else. `LYRASHIELD_LLM` is required for a real scan; provider credentials depend on the selected model.

### 7. Test a Scan Locally

```bash
# Set LLM provider
export LYRASHIELD_LLM="openai/gpt-4o"
export LLM_API_KEY="sk-..."

# Run a scan directly (without the platform)
lyrashield -n --target ./my-test-app --scan-mode quick

# Or through the platform UI:
# 1. Open http://localhost:3000
# 2. Create a target (repo or URL)
# 3. Click "New Scan"
# 4. Watch the scan timeline
```

### 8. Docker Deployment (Full Stack)

The project includes a `docker-compose.yml` and `Dockerfile` for full-stack Docker deployment.

```bash
cd ~/Desktop/lyrasec-ai

# Build and start all containers (postgres, redis, migrate, web, worker)
docker compose up --build -d

# Verify all containers are running
docker ps
# Should see: lyrashield-postgres (healthy), lyrashield-redis (healthy), lyrashield-web (running), lyrashield-worker (running)

# Test the web app
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# Should return: 200

# Run tests inside the container
docker exec lyrashield-worker sh -c "cd /app && pnpm vitest run"
# Should show: 727 tests passed

# Stop and clean up
docker compose down
```

### 9. (Optional) Add MinIO for Evidence Storage

```bash
# Add to docker-compose.yml:
# minio:
#   image: minio/minio:latest
#   container_name: lyrashield-minio
#   command: server /data --console-address ":9001"
#   ports:
#     - "9000:9000"
#     - "9001:9001"
#   environment:
#     MINIO_ROOT_USER: lyrashield
#     MINIO_ROOT_PASSWORD: lyrashield123
#   volumes:
#     - minio_data:/data

# Then add to .env:
# S3_ENDPOINT=http://localhost:9000
# S3_ACCESS_KEY=lyrashield
# S3_SECRET_KEY=lyrashield123
# S3_BUCKET=lyrashield-evidence
```

## Local Development Workflow

### Daily Development

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Start platform
pnpm dev

# 3. Make changes in apps/web or packages/*

# 4. Run tests
pnpm test          # unit tests (727 passing, 56 files)
pnpm typecheck     # TypeScript checks
pnpm lint          # ESLint

# 5. Database changes
pnpm db:migrate    # create + apply migration
pnpm db:generate   # regenerate Prisma client
```

### Engine Development

```bash
cd ~/Desktop/lyrashield-engine

# Run engine directly
uv run lyrashield -n --target ./test-app --scan-mode quick

# Run tests
uv run pytest

# Type check
uv run mypy lyrashield/
uv run pyright lyrashield/

# Lint
uv run ruff check .
uv run ruff format .
```

### Sync Engine from Upstream

```bash
cd ~/Desktop/lyrashield-engine

# Fetch latest from Strix
git fetch upstream

# Merge and resolve conflicts
git merge upstream/main

# Re-apply rebranding (if new files were added)
find . -type f \( -name "*.py" -o -name "*.md" \) -not -path "./.git/*" \
  -exec sed -i '' 's/STRIX_/LYRASHIELD_/g; s/Strix/LyraShield/g; s/strix/lyrashield/g' {} +

# Test
uv run pytest

# Commit
git add -A
git commit -m "sync: merge upstream + rebrand"
```

## Troubleshooting

### Port already in use
```bash
lsof -i :3000  # find process
kill <PID>     # kill it
```

### Database connection failed
```bash
docker compose restart postgres
docker compose logs postgres
```

### Prisma migration issues
```bash
pnpm db:push    # sync schema without migration (dev only)
npx prisma studio --schema packages/db/prisma/schema.prisma  # inspect data
```

### Engine not found
```bash
docker compose build worker
docker compose up -d worker
docker compose exec worker lyrashield --version
```

### Docker sandbox won't start
```bash
docker images | grep lyrashield-sandbox
# If missing:
cd ~/Desktop/lyrashield-engine/containers
docker build -t lyrashield-sandbox:latest -f Dockerfile ..
```
