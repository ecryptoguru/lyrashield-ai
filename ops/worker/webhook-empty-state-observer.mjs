// Installed with the reviewed producer bundle. Output stays in the root-owned
// host pipe; never attach it to public workflow logs or artifacts.
import {
  canonicalSupabaseDatabaseIdentity,
  hashDatabaseIdentity,
  parsePostgresConnectionTarget,
} from "../../packages/db/scripts/webhook-empty-state-contract.mjs"
import {
  sha256,
  requireValue,
  STATES,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"

export function connectionObservation(raw, resourceId, observedAt, migration = false) {
  const target = parsePostgresConnectionTarget(raw)
  if (migration) requireValue(target.port === "5432", "Migration must use direct/session5432")
  return {
    identitySha256: hashDatabaseIdentity(canonicalSupabaseDatabaseIdentity([raw])),
    credentialSha256: sha256(raw),
    resourceId,
    observedAt,
  }
}
export function redisObservation(raw, admissionValue, owner) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Invalid Redis target")
  }
  requireValue(
    url.protocol === "rediss:" &&
      !url.search &&
      !url.hash &&
      /^\/(?:[0-9]+)?$/.test(url.pathname || "/"),
    "Unsupported Redis endpoint options"
  )
  const stop = JSON.parse(admissionValue || "null")
  requireValue(
    stop?.owner === owner &&
      stop.operator === "github-actions" &&
      stop.reason === "webhook-empty-state" &&
      stop.runId === owner.split(":")[0],
    "Admission stop not owned"
  )
  return {
    identitySha256: sha256(
      JSON.stringify({
        scheme: url.protocol,
        host: url.hostname,
        port: url.port || "6379",
        database: url.pathname.slice(1) || "0",
      })
    ),
    credentialSha256: sha256(raw),
    owner,
    valueSha256: sha256(admissionValue),
  }
}
export async function schedulingObservation(client, queues) {
  const result = await client.query(`SELECT
    (SELECT count(*)::text FROM public."Scan" WHERE status IN ('QUEUED','PREFLIGHT','RUNNING','VERIFYING','REQUIRES_APPROVAL')) AS scans,
    (SELECT count(*)::text FROM public."WebhookEventTrack" WHERE status='processing') AS handlers,
    (SELECT count(*)::text FROM public."WebhookEventTrack") AS tracks,
    (SELECT count(*)::text FROM public."WebhookEvent" WHERE processed=false) AS parents`)
  const row = result.rows[0]
  const counts = Object.fromEntries(
    ["scans", "handlers", "tracks", "parents"].map((name) => {
      requireValue(/^[0-9]+$/.test(row[name]), "Invalid raw scheduling count")
      const value = Number(row[name])
      requireValue(Number.isSafeInteger(value), "Unbounded scheduling count")
      return [name, value]
    })
  )
  const snapshot = {}
  for (const [name, queue] of Object.entries(queues)) {
    const [jobs, schedulers, repeats] = await Promise.all([
      queue.getJobCounts(...STATES),
      queue.getJobSchedulersCount(),
      queue.getRepeatableJobs(0, -1, true),
    ])
    requireValue(Array.isArray(repeats), "Missing repeatable job observations")
    snapshot[name] = { counts: jobs, schedulers, repeats: repeats.length }
  }
  return {
    nonterminalScans: counts.scans,
    inFlightHandlers: counts.handlers,
    trackRows: counts.tracks,
    unresolvedParents: counts.parents,
    queues: snapshot,
  }
}
async function observe() {
  const [mode, resourceId, observedAt, owner] = process.argv.slice(2)
  requireValue(
    ["connection", "worker"].includes(mode) &&
      typeof resourceId === "string" &&
      resourceId.length < 1024 &&
      Number.isFinite(Date.parse(observedAt)),
    "Bounded observation inputs required"
  )
  if (mode === "connection")
    return connectionObservation(process.env.DATABASE_URL, resourceId, observedAt)
  const loader = createRequire("/app/apps/worker/package.json")
  const workerImport = (name) => import(pathToFileURL(loader.resolve(name)).href)
  const [{ Client }, integrations, { default: Redis }] = await Promise.all([
    workerImport("pg"),
    workerImport("@lyrashield/integrations"),
    workerImport("ioredis"),
  ])
  const client = new Client({
    connectionString: process.env.DATABASE_SYSTEM_URL,
    connectionTimeoutMillis: 5000,
  })
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 5000,
  })
  // Use the shared integration queue authorities, including fix generation.
  const queues = {
    scan: integrations.getScanQueue(),
    webhookTrackRetry: integrations.getWebhookTrackRetryQueue(),
    fixGenerate: integrations.getFixGenerateQueue(),
  }
  try {
    await client.connect()
    const direct = process.env.DATABASE_DIRECT_URL
    requireValue(
      direct === process.env.MIGRATION_DATABASE_URL,
      "Migration env aliases must be identical"
    )
    const backup = process.env.PRODUCTION_DATABASE_DIRECT_URL
    const database = {
      worker: connectionObservation(process.env.DATABASE_URL, resourceId, observedAt),
      system: connectionObservation(process.env.DATABASE_SYSTEM_URL, resourceId, observedAt),
      migration: connectionObservation(direct, "migration", observedAt, true),
      backup: connectionObservation(backup, "backup", observedAt, true),
    }
    return {
      database,
      redis: redisObservation(
        process.env.REDIS_URL,
        await redis.get("lyrashield:scan-admission:stopped"),
        owner
      ),
      ...(await schedulingObservation(client, queues)),
    }
  } finally {
    await Promise.allSettled([
      client.end(),
      redis.quit(),
      ...Object.values(queues).map((queue) => queue.close()),
      integrations.closeRedis(),
    ])
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(await observe()))
  } catch {
    process.stderr.write("Fixed empty-state observation failed\n")
    process.exitCode = 1
  }
}
