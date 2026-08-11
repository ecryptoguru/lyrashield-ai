# LyraShield Worker

BullMQ scan worker that runs repository and URL scans by orchestrating the LyraShield engine.

## Purpose

- Consumes scan jobs from the Redis-backed `scans` BullMQ queue.
- Performs preflight checks, builds the engine command, runs the sibling `lyrashield-engine` in a Docker sandbox, and parses the engine output.
- Persists findings, evidence, coverage receipts, manifests, and usage telemetry to the database and S3-compatible evidence storage.
- Classifies salvaged scans (`engine_stopped`, `content_filter_stopped`, `budget_exceeded` terminal reasons) with findings as `COMPLETED` rather than `FAILED`, preserving partial results for the user.
- Registers Redis heartbeats so `apps/web` can fail closed when no worker is live.
- Reconciles queue/database drift at startup and every minute.
- Reaps only old, stopped `strix-run-id` containers and owned checkout/run directories after confirming they are not attached to an active database scan.

## Tech stack

- Node.js 24 with TypeScript and `tsx`
- `bullmq` and `ioredis` for queue and Redis
- Docker sandbox for the engine
- `@lyrashield/db`, `@lyrashield/integrations`, `@lyrashield/security`, `@lyrashield/config`, `@lyrashield/logger`

## Scripts

```bash
pnpm dev
pnpm build
pnpm start
pnpm typecheck
pnpm lint
```

## Docker

The worker image is built via `docker compose build worker` and depends on the sibling `lyrashield-engine` repository. Local Compose uses a mutable development sandbox tag and the host Docker socket, so it is not a production topology. The release workflow checks out an exact engine revision, runs the engine-owned worker contract, builds and pushes the worker, then pulls and verifies that exact worker digest. See `docs/deployment/LOCAL_SETUP.md` and `docs/deployment/PRODUCTION_DEPLOYMENT.md`.

Repository profiles are resolved from `@lyrashield/types`: Safe and Quick are the same Luna profile ($1.20, 15 minutes), Standard is Luna ($3.20, 15 minutes), and Deep/Custom is Terra/medium with Luna/high specialists ($5, 45 minutes). The total ceilings reserve 3 minutes for deterministic scanners in Safe/Quick/Standard and 5 minutes in Deep. Web-app/API profiles are deterministic and do not invoke an AI model.

Prompt caching is enabled by default for supported GPT-5.6 routes. Engine artifacts report cache-read and cache-write tokens separately when available; the worker prices only complete per-request buckets and leaves ambiguous aggregates unreconciled rather than inventing a cost.

## See also

- `ops/worker/README.md`
- `packages/integrations`
- `codebase.md` §21 and later sections for scan orchestration details.
