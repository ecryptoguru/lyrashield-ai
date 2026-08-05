# LyraShield Worker

BullMQ scan worker that runs repository and URL scans by orchestrating the LyraShield engine.

## Purpose

- Consumes scan jobs from the Redis-backed `scans` BullMQ queue.
- Performs preflight checks, builds the engine command, runs the sibling `lyrashield-engine` in a Docker sandbox, and parses the engine output.
- Persists findings, evidence, coverage receipts, manifests, and usage telemetry to the database and S3-compatible evidence storage.
- Classifies salvaged scans (`engine_stopped`, `content_filter_stopped`, `budget_exceeded` terminal reasons) with findings as `COMPLETED` rather than `FAILED`, preserving partial results for the user.
- Registers Redis heartbeats so `apps/web` can fail closed when no worker is live.
- Reconciles queue/database drift at startup and every minute.

## Tech stack

- Node.js 20+ with TypeScript and `tsx`
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

The worker image is built via `docker compose build worker` and depends on the sibling `lyrashield-engine` repository. See `docs/deployment/LOCAL_SETUP.md` for the full local setup.

## See also

- `ops/worker/README.md`
- `packages/integrations`
- `codebase.md` §21 and later sections for scan orchestration details.
