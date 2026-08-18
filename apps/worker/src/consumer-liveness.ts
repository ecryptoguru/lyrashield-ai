import { SCAN_QUEUE_NAME } from "@lyrashield/types"
import { getRedis } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"

/**
 * Consumer liveness guard for the BullMQ scan worker.
 *
 * The worker can silently stop claiming jobs while the process stays alive and
 * `worker.isRunning()` remains true — a known BullMQ failure mode on
 * single-primary Redis (taskforcesh/bullmq#4479). After a transient connection
 * reset, the blocking client (`bclient`) reconnects to `ready` and keeps
 * re-issuing `BZPOPMIN`, but the fetch loop never wakes for waiting work. Jobs
 * pile up in `<queue>:wait`, `active` stays 0, and the only recovery is a
 * restart (or an external `queue.add` writing a marker). BullMQ fixed this in
 * v6.0.7; on the pinned 5.81.x line the production-safe mitigation is an
 * app-level liveness guard.
 *
 * The guard tracks the last time the worker actually claimed a job
 * (`markScanJobClaimed`). On each tick it checks the queue: if jobs are waiting
 * but the consumer has been idle for longer than one blocking window
 * (`BLOCK_MS`) plus a grace margin, the fetch loop is presumed wedged and the
 * caller fails closed (the process exits so systemd `Restart=always`
 * re-attaches a fresh consumer — the same recovery the manual restart
 * achieves). A genuinely idle queue (nothing waiting) never trips the guard.
 */

// The worker's blocking fetch waits up to `drainDelay` seconds per call; an
// additional margin covers reconnect/renewal slop without false-positiving on
// a worker that is busy but between claims. Jobs should be picked up within
// seconds, so 3 minutes of "waiting but unclaimed" is a confident wedge signal.
const BLOCK_MS = 600_000
const GRACE_MS = 120_000

let lastClaimAt = Date.now()

/** Record that the worker just claimed a job. Called at the top of the processor. */
export function markScanJobClaimed(now = Date.now()): void {
  lastClaimAt = now
}

/** Test hook: reset the claim clock to a known value. */
export function resetScanConsumerLiveness(now = Date.now()): void {
  lastClaimAt = now
}

export interface ScanConsumerLiveness {
  /** Jobs currently waiting in the scan queue. */
  waiting: number
  /** Milliseconds since the worker last claimed a job. */
  idleForMs: number
  /** True when jobs are waiting but the consumer has been idle past the wedge threshold. */
  wedged: boolean
}

/**
 * Inspect consumer liveness. Returns null when Redis is unavailable — the
 * caller treats that as "no signal" and keeps running (Redis being down is a
 * separate, already-logged failure mode; this guard only fires on a confirmed
 * idle-despite-waiting wedge).
 */
export async function checkScanConsumerLiveness(now = Date.now()): Promise<ScanConsumerLiveness | null> {
  const redis = getRedis()
  if (!redis) return null

  let waiting: number
  try {
    waiting = await redis.llen(`bull:${SCAN_QUEUE_NAME}:wait`)
  } catch (error) {
    logger.warn("Scan consumer liveness check failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  const idleForMs = now - lastClaimAt
  const wedged = waiting > 0 && idleForMs > BLOCK_MS + GRACE_MS
  return { waiting, idleForMs, wedged }
}
