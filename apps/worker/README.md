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

The worker image is built via `docker compose build worker` and depends on the sibling `lyrashield-engine` repository. Local Compose uses a mutable development sandbox tag and the host Docker socket, so it is not a production topology. The release workflow checks out an exact engine revision, runs the engine-owned worker contract, builds and pushes the worker, then pulls and verifies that exact worker digest. A separate operator promotion updates the dedicated worker VM to that digest and reconciles the running reference, OCI labels, Docker health, and `/api/ready/scans`; no worker follows a mutable tag automatically. See `docs/deployment/LOCAL_SETUP.md` and `docs/deployment/PRODUCTION_DEPLOYMENT.md`.

Repository profiles are resolved from `@lyrashield/types`: Safe/Quick and Standard use Luna; Deep/Custom uses Terra/medium with Luna/high specialists. Model budget ceilings are $1.20/$3.20/$5.00, not expected charges. Analysis is bounded to 15/15/45 minutes, with engine ceilings of 12/12/40 minutes and a reserved deterministic-scanner interval. Elapsed time is reconstructed from persisted start time on retry and advances monotonically within an attempt. Optional triage consumes the remaining analysis interval. Workspace cleanup has a separate 30-second grace period and reports failures for operator attention. Web-app/API profiles remain deterministic and do not invoke an AI model.

Prompt caching is enabled by default for supported GPT-5.6 routes. Engine artifacts report cache-read and cache-write tokens separately when available; the worker prices only complete per-request buckets and leaves ambiguous aggregates unreconciled rather than inventing a cost.

## See also

- `ops/worker/README.md`
- `packages/integrations`
- `codebase.md` sections 4–6 for scan orchestration, runtime contracts, and domain maps.
