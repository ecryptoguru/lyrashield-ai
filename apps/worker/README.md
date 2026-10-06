# LyraShield Worker

BullMQ scan worker that runs repository and URL scans by orchestrating the LyraShield engine.

## Purpose

- Consumes scan jobs from the Redis-backed `scans` BullMQ queue.
- Performs preflight checks, builds the engine command, runs the sibling `lyrashield-engine` in a Docker sandbox, and parses the engine output.
- Persists findings, evidence, coverage receipts, manifests, and usage telemetry to the database and S3-compatible evidence storage.
- Preserves findings from truncated engine runs. Content-filter, engine-stop (model error) or runtime-deadline truncations finish as `PARTIAL` when findings were filed and `FAILED` otherwise; each records a bounded coverage receipt so a truncated engine scope never reads as a complete pass, and deterministic scanners still run afterward. A protected run-limit stop finishes as `STOPPED_BUDGET`.
- Registers Redis heartbeats so `apps/web` can fail closed when no worker is live.
- Reconciles queue/database drift at startup, then checks every five minutes. When no nonterminal scans exist, it skips BullMQ inspection until the hourly backstop; a failed database preflight runs reconciliation fail-safe.
- Reaps only old, stopped `strix-run-id` containers and owned checkout/run directories after confirming they are not attached to an active database scan.

## Tech stack

- Node.js 24 with TypeScript and `tsx`
- `bullmq` and `ioredis` for queue and Redis
- Docker sandbox for the engine
- `@lyrashield/db`, `@lyrashield/integrations`, `@lyrashield/security`, `@lyrashield/config`, `@lyrashield/logger`

## Scripts

```bash
pnpm --filter @lyrashield/worker dev
pnpm --filter @lyrashield/worker start
pnpm --filter @lyrashield/worker typecheck
pnpm --filter @lyrashield/worker lint
pnpm exec vitest run apps/worker/src
```

The worker package has no build script; the production image runs the TypeScript entrypoint with `tsx`.

## Docker

The worker image is built via `docker compose build worker` and depends on the sibling `lyrashield-engine` repository. Local Compose uses a mutable development sandbox tag and the host Docker socket, so it is not a production topology. The release workflow checks out an exact engine revision, runs the engine-owned worker contract, builds and pushes the worker, then pulls and verifies that exact worker digest. A separate operator promotion updates the dedicated worker VM to that digest and reconciles the running reference, OCI labels, Docker health, and `/api/ready/scans`; no worker follows a mutable tag automatically.

Repository profiles and duration ceilings are defined in [`packages/types/src/scan-profile.ts`](../../packages/types/src/scan-profile.ts); [the user guide](../../docs/user-guide.md#8-scan-types-and-models) lists the user-facing choices. Repository Safe/Quick/Standard use GPT-6 Luna/medium; Deep/Custom use GPT-6 Sol/medium with Luna/high specialists. Web-app/API Safe profiles are deterministic-only; Standard and Deep invoke the engine through the scan-scoped relay. Model budgets are ceilings, not expected charges. Elapsed time is reconstructed from persisted start time on retry and advances monotonically within an attempt. Optional triage consumes the remaining analysis interval. Workspace cleanup has a separate 30-second grace period and reports failures for operator attention.

Prompt caching is enabled by default for supported GPT-6 routes. Engine artifacts report cache-read and cache-write tokens separately; the worker prices only complete GPT-6 per-request buckets and leaves ambiguous or unsupported model receipts unreconciled rather than inventing a cost. Paid production admission still requires exact-release provider runs, reconciliation, and protected approval.

Exact triage-result reuse is a separate optimization and stays off by default (`LYRASHIELD_AI_RESULT_CACHE_MODE=off`). Enabling `observe` or `enforce` requires the dedicated TLS Redis endpoint and key in the `LYRASHIELD_AI_CACHE_REDIS_URL` and `LYRASHIELD_AI_CACHE_KEY_SECRET` deployment secrets, plus a 64-character SHA-256 provider fingerprint in `LYRASHIELD_AI_CACHE_PROVIDER_FINGERPRINT`. The Azure workflow syncs the mode and credentials through the worker VM's Key Vault; `refresh-secrets.sh` loads them into the worker, and `refresh-egress.sh` pins the dedicated cache endpoint. The web app receives only the cache URL and index key through its separate app-only Key Vault for target-deletion purge; the public scanner receives neither. Web reuse stays off, and existing purge credential bindings remain when worker reuse is disabled. TLS endpoints support both ACL username/password and password-only authentication. Deployment validation rejects a Redis host shared with BullMQ or rate limiting. Provision that cache separately; do not reuse either existing Redis service. Keep reuse disabled until the paired quality, cost, tenant-isolation, and operational cohort gates pass.

## See also

- `ops/worker/README.md`
- `packages/integrations`
- `codebase.md` sections 4–6 for scan orchestration, runtime contracts, and domain maps.
