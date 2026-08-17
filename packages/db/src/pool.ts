import { PrismaPg } from "@prisma/adapter-pg"

/**
 * Build a Prisma pg adapter with a BOUNDED connection pool.
 *
 * The production Postgres sits behind a session-mode pooler capped at 15
 * clients. This app creates more than one Prisma client per process (the
 * RLS-scoped client and the privileged system client), and several processes
 * (web, worker, scanner) share that pooler. With the pg default (max: 10) per
 * adapter, a couple of processes exhaust the pooler and every DB call starts
 * failing with `EMAXCONNSESSION: max clients reached in session mode` — which
 * wedged the production scan worker (2026-08-17).
 *
 * Cap each adapter's pool so the whole stack stays under the pooler limit.
 * Override per-deployment with LYRASHIELD_DB_POOL_MAX (an env override, not a
 * code change, keeps the ceiling adjustable without a redeploy of the value).
 * The default of 4 per adapter leaves headroom for two clients per process
 * plus the web/scanner processes against the 15-client pooler.
 */
const DEFAULT_DB_POOL_MAX = 4

export function resolveDbPoolMax(runtimeEnv: NodeJS.ProcessEnv = process.env): number {
  const raw = runtimeEnv.LYRASHIELD_DB_POOL_MAX?.trim()
  if (!raw) return DEFAULT_DB_POOL_MAX
  const parsed = Number.parseInt(raw, 10)
  // An unparseable or non-positive value falls back to the safe default — it
  // must never disable the cap (that would reintroduce the pool exhaustion).
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DB_POOL_MAX
  return parsed
}

export function createBoundedPgAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    max: resolveDbPoolMax(),
    // Free idle connections instead of pinning them for the pool's lifetime so
    // an idle process does not hold pooler slots it is not using.
    idleTimeoutMillis: 10_000,
    // Do not let a query wait forever for a free connection when the pool is
    // momentarily full — surface a fast, observable error instead of a hang.
    connectionTimeoutMillis: 5_000,
  })
}
