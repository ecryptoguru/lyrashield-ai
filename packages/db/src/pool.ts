import { logger } from "@lyrashield/logger"
import { PrismaPg } from "@prisma/adapter-pg"
import { performance } from "node:perf_hooks"
import pg from "pg"
import { createPgConnectionConfig } from "./connection-config"

type DatabasePoolScope = "db" | "db:system"
// SQLSTATE uses five uppercase alphanumeric characters; native socket/DNS
// errors are accepted only from this fixed Node.js code list.
const SAFE_NODE_CONNECTION_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
])

function elapsedDurationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function safePoolErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined

  try {
    const code = (error as { code?: unknown }).code
    if (typeof code !== "string") return undefined
    if (/^[0-9A-Z]{5}$/.test(code) || SAFE_NODE_CONNECTION_ERROR_CODES.has(code)) return code
  } catch {
    // A malformed error object must not turn diagnostic logging into a failure.
  }

  return undefined
}

function poolCounts(pool: pg.Pool, scope: DatabasePoolScope): Record<string, number | string> {
  return {
    scope,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  }
}

/**
 * Observe Prisma's pg pool without logging connection details, error messages,
 * SQL, or request data. Keep both pg.Pool.connect overloads working because
 * pg.Pool.query uses the callback form internally.
 */
export function observePgPoolConnections(pool: pg.Pool, scope: DatabasePoolScope): void {
  const connect = pool.connect.bind(pool)

  pool.connect = ((callback?: Parameters<pg.Pool["connect"]>[0]) => {
    const startedAt = performance.now()
    const poolCountsWithDuration = () => ({
      ...poolCounts(pool, scope),
      durationMs: elapsedDurationMs(startedAt),
    })
    const onFailure = (error: unknown) => {
      const code = safePoolErrorCode(error)
      logger.warn("Database pool connection failed", {
        ...poolCountsWithDuration(),
        ...(code ? { code } : {}),
      })
    }
    const onAcquired = () =>
      logger.debug("Database pool connection acquired", poolCountsWithDuration())

    logger.debug("Database pool connection attempt", poolCountsWithDuration())

    if (callback) {
      return connect((error, client, release) => {
        if (error) onFailure(error)
        else onAcquired()
        callback(error, client, release)
      })
    }

    return connect().then(
      (client) => {
        onAcquired()
        return client
      },
      (error: unknown) => {
        onFailure(error)
        throw error
      }
    )
  }) as pg.Pool["connect"]

  // pg-pool emits this for errors from already-connected idle clients. It
  // does not emit it for initial connect failures, which are handled above.
  pool.on("error", () => logger.warn("Database pool idle client error", poolCounts(pool, scope)))
}

class ObservablePrismaPg extends PrismaPg {
  private readonly observedPools = new WeakSet<pg.Pool>()

  constructor(
    config: pg.PoolConfig,
    private readonly scope: DatabasePoolScope
  ) {
    super(config)
  }

  private observeAdapterPool(adapter: { underlyingDriver(): pg.Pool }): void {
    const pool = adapter.underlyingDriver()
    if (this.observedPools.has(pool)) return
    observePgPoolConnections(pool, this.scope)
    this.observedPools.add(pool)
  }

  override async connect() {
    const adapter = await super.connect()
    this.observeAdapterPool(adapter)
    return adapter
  }

  override async connectToShadowDb() {
    const adapter = await super.connectToShadowDb()
    this.observeAdapterPool(adapter)
    return adapter
  }
}

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

export function createBoundedPgAdapter(
  connectionString: string,
  scope: DatabasePoolScope = "db"
): PrismaPg {
  return new ObservablePrismaPg(
    {
      ...createPgConnectionConfig(connectionString),
      max: resolveDbPoolMax(),
      // Free idle connections instead of pinning them for the pool's lifetime so
      // an idle process does not hold pooler slots it is not using.
      idleTimeoutMillis: 10_000,
      // Do not let a query wait forever for a free connection when the pool is
      // momentarily full — surface a fast, observable error instead of a hang.
      connectionTimeoutMillis: 5_000,
    },
    scope
  )
}
