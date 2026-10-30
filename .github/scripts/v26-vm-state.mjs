import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { observeRuntimeDatabase, fingerprint } from "./v26-runtime-database.mjs"
import {
  claimDurableStop,
  requireOwnedStop,
  recordPhase,
  releaseDurableStop,
  readDurableReceipt,
  assertOperationalReceipt,
} from "./v26-durable-state.mjs"

const require = createRequire("/app/apps/worker/package.json")
const databaseRequire = createRequire(require.resolve("@lyrashield/db"))
const integrationRequire = createRequire(require.resolve("@lyrashield/integrations"))
const { Client } = databaseRequire("pg")
const Redis = integrationRequire("ioredis")
const path = "/v26-state/v26-cutover.json"
const action = process.argv[2]
const request = JSON.parse(Buffer.from(process.argv[3], "base64").toString())
const extra = process.argv[4] ? JSON.parse(Buffer.from(process.argv[4], "base64").toString()) : {}
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 10000,
  commandTimeout: 10000,
})
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
})
const context = { path, redis, request }

async function observe() {
  const actual = await observeRuntimeDatabase(client)
  return {
    ...actual,
    databaseUrlSha256: fingerprint(process.env.DATABASE_URL),
    databaseSystemUrlSha256: fingerprint(process.env.DATABASE_SYSTEM_URL ?? ""),
    redisUrlSha256: fingerprint(process.env.REDIS_URL),
  }
}
async function continuity(receipt) {
  const actual = await observe()
  if (
    actual.databaseIdentity !== request.databaseIdentity ||
    actual.redisUrlSha256 !== request.redisIdentity
  )
    throw new Error("v26 connection continuity failed")
  if (
    receipt &&
    Object.entries(receipt.baseline.worker).some(([key, value]) => actual[key] !== value)
  )
    throw new Error("v26 live worker connection changed")
  return actual
}
async function queues() {
  // Read only. Names are the owning queue.ts contracts; do not create a
  // one-off BullMQ queue, cancel jobs, delete keys or replay any execution.
  for (const name of ["scans", "webhook-track-retry", "fix-generate"]) {
    for (const state of ["wait", "active", "paused"])
      if ((await redis.llen(`bull:${name}:${state}`)) !== 0)
        throw new Error("v26 queue remains occupied")
    for (const state of ["delayed", "prioritized", "waiting-children"])
      if ((await redis.zcard(`bull:${name}:${state}`)) !== 0)
        throw new Error("v26 queue remains occupied")
  }
}
async function candidate() {
  const { SCAN_ACCOUNTING_PROTOCOL, createScan, lockUserScanAdmission, releaseStoppedScanSlot } =
    await import(require.resolve("@lyrashield/db"))
  const { reserveScanCapacity, confirmScanCapacityStopped } = await import(
    require.resolve("@lyrashield/billing")
  )
  if (
    SCAN_ACCOUNTING_PROTOCOL !== "reservations/2" ||
    [
      createScan,
      lockUserScanAdmission,
      releaseStoppedScanSlot,
      reserveScanCapacity,
      confirmScanCapacityStopped,
    ].some((fn) => typeof fn !== "function") ||
    process.env.LYRASHIELD_PRODUCT_REVISION !== request.sourceRevision ||
    process.env.LYRASHIELD_ENGINE_REVISION !== request.engineRevision ||
    process.env.LYRASHIELD_WORKER_IMAGE_DIGEST !== request.workerDigest
  )
    throw new Error("v26 running candidate capability mismatch")
}
try {
  await client.connect()
  if (action === "probe") {
    const observed = await observe()
    const saved = readDurableReceipt(path)
    if (saved)
      assertOperationalReceipt(saved, saved.phase === "COMPLETE" ? saved.identity : request)
    console.log(
      "V26_PRIVATE=" +
        Buffer.from(
          JSON.stringify({ worker: observed, receipt: saved ? { phase: saved.phase } : null })
        ).toString("base64")
    )
  } else if (action === "claim") {
    const actual = await continuity()
    if (Object.entries(extra.worker).some(([key, value]) => actual[key] !== value))
      throw new Error("v26 worker baseline changed")
    await claimDurableStop({ ...context, baseline: extra })
  } else if (action === "owned") {
    await continuity(await requireOwnedStop(context))
  } else if (action === "queues") {
    await continuity(await requireOwnedStop(context))
    await queues()
  } else if (action === "quiesced") {
    const receipt = await requireOwnedStop(context)
    await continuity(receipt)
    await queues()
    const proof = JSON.parse(readFileSync("/v26-stop/worker-stop-provenance.json", "utf8"))
    if (
      proof.imageReference !== receipt.baseline.workerImage ||
      proof.capturedAtEpochSeconds < receipt.baseline.claimEpoch ||
      ["databaseUrlSha256", "databaseSystemUrlSha256", "redisUrlSha256"].some(
        (key) => proof[key] !== receipt.baseline.worker[key]
      )
    )
      throw new Error("v26 fresh worker stop provenance unavailable")
    if (receipt.phase === "CLAIMED")
      await recordPhase(context, "QUIESCED", {
        stopReceiptSha256: fingerprint(JSON.stringify(proof)),
      })
  } else if (action === "inventory") {
    const receipt = await requireOwnedStop(context, undefined)
    await continuity(receipt)
    await queues()
    if (receipt.phase === "QUIESCED") await recordPhase(context, "INVENTORIED", extra)
  } else if (action === "migration-intent") {
    const receipt = await requireOwnedStop(context)
    await continuity(receipt)
    await queues()
    if (receipt.phase === "INVENTORIED") await recordPhase(context, "MIGRATION_INTENT", extra)
    else if (!["MIGRATION_INTENT", "MIGRATED"].includes(receipt.phase))
      throw new Error("v26 migration phase invalid")
  } else if (action === "migrated") {
    const receipt = await requireOwnedStop(context)
    await continuity(receipt)
    await queues()
    if (receipt.phase === "MIGRATION_INTENT") await recordPhase(context, "MIGRATED", extra)
    else if (receipt.phase !== "MIGRATED") throw new Error("v26 migration phase invalid")
  } else if (action === "verify") {
    const receipt = await requireOwnedStop(context)
    await continuity(receipt)
    await queues()
    await candidate()
    if (receipt.phase === "MIGRATED") await recordPhase(context, "VERIFIED", extra)
    else if (receipt.phase !== "VERIFIED") throw new Error("v26 verification phase invalid")
  } else if (action === "release") {
    await releaseDurableStop(context, async (receipt) => {
      await continuity(receipt)
      await candidate()
    })
  } else throw new Error("Unsupported v26 VM phase")
  console.log("V26_PHASE_OK=" + action)
} catch {
  console.error("v26 VM phase failed; preserve admission and durable receipt")
  process.exitCode = 1
} finally {
  await Promise.allSettled([client.end(), redis.quit()])
}
