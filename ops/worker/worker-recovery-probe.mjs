// Read-only recovery qualification; the original protected epoch is never captured here.
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

// UNKNOWN operation/outbox states are already non-executable in the persisted
// authority. A lifetime billable marker also makes pending-finalization refuse
// provider replay. Leave these records and their slots untouched.
export const RECOVERY_UNKNOWN_SQL = `
SELECT (
 EXISTS (SELECT 1 FROM "ScanCapacityReservation" r LEFT JOIN "Scan" s ON s.id = r."scanId"
   WHERE (r.state = 'REVIEW_REQUIRED' OR (r.state IN ('RUNNING', 'SETTLED') AND r."stoppedAt" IS NULL))
   AND (s.id IS NULL OR r."workspaceId" <> s."workspaceId" OR
        r."accountId" <> COALESCE(s."sponsorAccountId", s."createdById") OR
        NOT EXISTS (SELECT 1 FROM "ScanEvent" e WHERE e."scanId" = r."scanId" AND e.stage = 'billable_boundary'))) OR
 EXISTS (SELECT 1 FROM "ScanPhysicalExecution" p WHERE p.state = 'UNKNOWN' AND
   NOT EXISTS (SELECT 1 FROM "ScanDispatchOperation" o WHERE o."operationId" = p."operationId"
     AND o."scanId" = p."scanId" AND o."workspaceId" = p."workspaceId" AND o.state = 'UNKNOWN'))
) AS unknown`

export async function assertRecoveryDatabase({ query, expected }) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("Original database epoch pin missing")
  const epoch = await query("SELECT extract(epoch from pg_postmaster_start_time())::text AS epoch")
  const value = epoch.rows?.[0]?.epoch
  if (
    epoch.rows?.length !== 1 ||
    typeof value !== "string" ||
    !/^\d+\.\d+$/.test(value) ||
    createHash("sha256").update(value).digest("hex") !== expected
  ) {
    throw new Error("Original database epoch changed or unavailable")
  }
  const result = await query(RECOVERY_UNKNOWN_SQL)
  if (result.rows?.length !== 1 || result.rows[0].unknown !== false) {
    throw new Error("Paid effects remain held for reconciliation")
  }
}

async function main() {
  const require = createRequire("/app/apps/worker/package.json")
  const { Pool } = require(require.resolve("pg", { paths: [require.resolve("@lyrashield/db")] }))
  const { default: Redis } = await import(pathToFileURL(require.resolve("ioredis")))
  const [phase, ownedValue] = process.argv.slice(2)
  if (
    !ownedValue ||
    process.env.LYRASHIELD_COLD_SINGLE_WORKER !== "1" ||
    !process.env.DATABASE_URL ||
    !process.env.DATABASE_SYSTEM_URL ||
    !process.env.REDIS_URL
  ) {
    throw new Error("Recovery policy missing")
  }
  const ownership = JSON.parse(ownedValue)
  if (
    ownership.operator !== "worker-recovery" ||
    ownership.reason !== "native-cold-restart" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ownership.owner ?? "")
  ) {
    throw new Error("Recovery ownership is unavailable")
  }
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000 })
  const key = "lyrashield:scan-admission:stopped"
  let pool
  try {
    if (phase === "claim") {
      const result = await redis.eval(
        'local current=redis.call("GET",KEYS[1]); if current and current~=ARGV[1] then return 0 end; redis.call("SET",KEYS[1],ARGV[1]); return 1',
        1,
        key,
        ownedValue
      )
      if (result !== 1) throw new Error("Foreign admission stop preserved")
    } else {
      if ((await redis.get(key)) !== ownedValue)
        throw new Error("Recovery admission ownership changed")
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
        query_timeout: 10000,
        statement_timeout: 10000,
      })
      const epochQuery = pool.query.bind(pool)
      // Runtime role establishes the same epoch the worker guard checks.
      const epoch = await epochQuery(
        "SELECT current_database() AS database, extract(epoch from pg_postmaster_start_time())::text AS epoch"
      )
      // Global ambiguity checks require the trusted operational connection, never an RLS-filtered result.
      const systemPool = new Pool({
        connectionString: process.env.DATABASE_SYSTEM_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
        query_timeout: 10000,
        statement_timeout: 10000,
      })
      try {
        const identity = await systemPool.query(
          "SELECT current_database() AS database, extract(epoch from pg_postmaster_start_time())::text AS epoch"
        )
        if (
          identity.rows.length !== 1 ||
          epoch.rows.length !== 1 ||
          identity.rows[0].database !== epoch.rows[0].database ||
          identity.rows[0].epoch !== epoch.rows[0].epoch
        ) {
          throw new Error("Recovery database connections do not match")
        }
        await assertRecoveryDatabase({
          expected: process.env.LYRASHIELD_COLD_DATABASE_EPOCH_SHA256,
          query: (sql) =>
            sql === RECOVERY_UNKNOWN_SQL ? systemPool.query(sql) : Promise.resolve(epoch),
        })
      } finally {
        await systemPool.end()
      }
      if (phase === "release") {
        const released = await redis.eval(
          'if redis.call("GET",KEYS[1])~=ARGV[1] then return 0 end; redis.call("DEL",KEYS[1]); return 1',
          1,
          key,
          ownedValue
        )
        if (released !== 1) throw new Error("Recovery admission ownership changed")
      } else if (phase !== "check") throw new Error("Invalid recovery phase")
    }
    console.log("MATCH")
  } finally {
    if (pool) await pool.end()
    await redis.quit()
  }
}

if (process.argv[1]?.endsWith("worker-recovery-probe.mjs")) {
  main().catch(() => {
    console.error("Automatic recovery remains held")
    process.exitCode = 1
  })
}
