// Run with the protected worker's already-resolved BullMQ Redis and global,
// read-only database connection. A fresh launch cannot adopt an existing latch.
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import {
  ownedHold,
  pairedReleaseReceipt,
  SCAN_ADMISSION_KEY,
} from "../../ops/monitoring/paired-release-hold.mjs"

function identity(pair) {
  return [pair.owner, pair.productRevision, pair.engineRevision, pair.workerDigest]
}

export function pairedHold(redis, pair) {
  const args = identity(pair)
  const receipt = pairedReleaseReceipt(...args)
  return {
    async claim() {
      assert.equal(
        await redis.set(SCAN_ADMISSION_KEY, receipt, "NX"),
        "OK",
        "admission already held"
      )
      await ownedHold(redis, "assert", ...args)
    },
    assert: () => ownedHold(redis, "assert", ...args),
    release: () => ownedHold(redis, "release", ...args),
    async state() {
      // GET and PTTL must describe the same instant.
      return await redis.eval(
        'local v=redis.call("GET",KEYS[1]); if not v then return "absent" end; if v==ARGV[1] and redis.call("PTTL",KEYS[1])==-1 then return "owned" end; return "foreign"',
        1,
        SCAN_ADMISSION_KEY,
        receipt
      )
    },
  }
}

class PairedWorkPending extends Error {}

function assertEmptyCount(value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, "invalid queue count")
  if (value !== 0) throw new PairedWorkPending("pending queue work")
}

// An observable nonempty queue or database can drain naturally. Unavailable
// readers, uncertain physical children and foreign holds fail immediately.
// Callers must configure bounded Redis/DB connection and command timeouts.
export async function waitForPairedDrain(pair, redis, db, inspectPhysicalChildren, signal) {
  const hold = pairedHold(redis, pair)
  const deadline = performance.now() + 120_000
  for (;;) {
    signal?.throwIfAborted()
    await hold.assert()
    try {
      await assertPairedWorkDrained(redis, db, inspectPhysicalChildren)
      await hold.assert()
      signal?.throwIfAborted()
      return
    } catch (error) {
      if (!(error instanceof PairedWorkPending) || performance.now() >= deadline) throw error
      await delay(Math.min(2000, deadline - performance.now()), undefined, { signal })
    }
  }
}

export async function assertPairedWorkDrained(redis, db, inspectPhysicalChildren) {
  for (const name of ["scans", "webhook-track-retry", "fix-generate"]) {
    for (const state of ["wait", "active", "paused"])
      assertEmptyCount(await redis.llen(`bull:${name}:${state}`))
    for (const state of ["delayed", "prioritized", "waiting-children"])
      assertEmptyCount(await redis.zcard(`bull:${name}:${state}`))
  }
  // Fail if RLS would silently filter global observations. Preserve soft-deleted
  // scans with unsettled financial ownership as well as capacity and slot rows.
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    await db.query("SET LOCAL statement_timeout = '10s'")
    await db.query("SET LOCAL row_security = off")
    // A surviving v2 Scan must have its slot-release acknowledgement, including
    // nonbillable work. The stopped funding record can outlive its parent.
    const result = await db.query(`SELECT
      NOT EXISTS (SELECT 1 FROM public."Scan" WHERE status NOT IN
        ('COMPLETED','PARTIAL','FAILED','CANCELLED','STOPPED_BUDGET','TIMED_OUT')
        OR ("accountingVersion"=2 AND "accountingSettledAt" IS NULL))
      AND NOT EXISTS (SELECT 1 FROM public."ScanCapacityReservation"
        WHERE state NOT IN ('SETTLED','RELEASED') OR "stoppedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public."UserScanSlot")
      AND NOT EXISTS (SELECT 1 FROM public."AgentApproval" WHERE status='EXECUTING')
      AND NOT EXISTS (SELECT 1 FROM public.agent_operations WHERE status='EXECUTING')
      AND NOT EXISTS (SELECT 1 FROM public."WebhookEventTrack"
        WHERE status NOT IN ('succeeded','dead_letter','reviewed')) AS drained`)
    assert.equal(result.rows?.length, 1, "incomplete global drain evidence")
    assert.equal(typeof result.rows[0].drained, "boolean", "invalid global drain evidence")
    if (!result.rows[0].drained)
      throw new PairedWorkPending("unresolved execution or financial ownership")
  } finally {
    await db.query("ROLLBACK")
  }
  // Use the checked-in read-only v26-execution-drain.sh in the protected
  // host adapter. An empty stdout or failed Docker inspection is not proof.
  assert.equal(await inspectPhysicalChildren(), "V26_EXECUTION_DRAIN_VERIFIED")
}
