/**
 * Agent-minute metering.
 *
 * Records wall-clock agent minutes consumed during a scan. Idempotent via
 * UsageRecord.idempotencyKey = `{workspaceId}:{scanId}:{phase}`.
 *
 * Per D1 constraint: agent-minutes are measured as WALL-CLOCK duration,
 * NOT "active-loop" or "thinking time". The caller passes the elapsed
 * wall-clock milliseconds; this module converts to integer minutes.
 *
 * Deep/Custom scans consume minutes at 3× the standard rate (DEEP_SCAN_MULTIPLIER).
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { DEEP_SCAN_MULTIPLIER } from "@lyrashield/pricing"
import type { ScanMode } from "@lyrashield/types"

export interface RecordAgentMinutesOptions {
  /** Scan mode — Deep/Custom applies a 3× multiplier. */
  mode?: ScanMode
  /** Phase label for the idempotency key (e.g. "tick_0", "final"). */
  phase?: string
  /** Cycle start for this billing period. */
  cycleStart?: Date
}

export interface RecordAgentMinutesResult {
  /** Whether a new usage record was created (false = idempotent replay). */
  created: boolean
  /** Minutes recorded (after multiplier, 0 on replay). */
  minutes: number
  /** The idempotency key used. */
  idempotencyKey: string
}

/**
 * Record agent minutes consumed during a scan phase.
 *
 * The caller passes wall-clock milliseconds. This function:
 * 1. Converts ms → integer minutes (ceiling, minimum 1 if ms > 0)
 * 2. Applies the Deep/Custom 3× multiplier
 * 3. Inserts a UsageRecord with an idempotency key
 * 4. Returns whether a new record was created
 *
 * If the same idempotency key already exists, the call is a no-op (idempotent).
 */
export async function recordAgentMinutes(
  workspaceId: string,
  scanId: string,
  ms: number,
  opts: RecordAgentMinutesOptions = {}
): Promise<RecordAgentMinutesResult> {
  const phase = opts.phase ?? "default"
  const idempotencyKey = `${workspaceId}:${scanId}:${phase}`

  // Idempotency check: if a record with this key exists, return early.
  const existing = await prisma.usageRecord.findUnique({
    where: { idempotencyKey },
    select: { id: true, quantity: true },
  })
  if (existing) {
    return { created: false, minutes: 0, idempotencyKey }
  }

  if (ms <= 0) {
    return { created: false, minutes: 0, idempotencyKey }
  }

  // A-L06: Validate input bounds — reject oversized ms values.
  // A single tick should never represent more than 1 hour of wall-clock time;
  // larger values indicate a bug or abuse attempt.
  const MAX_TICK_MS = 60 * 60 * 1000 // 1 hour
  if (!Number.isFinite(ms) || ms > MAX_TICK_MS) {
    return { created: false, minutes: 0, idempotencyKey }
  }

  // Wall-clock ms → integer minutes (ceiling, min 1)
  const rawMinutes = Math.max(1, Math.ceil(ms / 60_000))

  // Deep/Custom scans consume 3× minutes
  const isDeep = opts.mode === "DEEP" || opts.mode === "CUSTOM"
  const minutes = isDeep ? rawMinutes * DEEP_SCAN_MULTIPLIER : rawMinutes

  try {
    await prisma.usageRecord.create({
      data: {
        workspaceId,
        kind: "agent_minutes",
        quantity: minutes,
        idempotencyKey,
        cycleStart: opts.cycleStart ?? null,
        metadata: {
          scanId,
          mode: opts.mode ?? null,
          wallClockMs: ms,
          rawMinutes,
          multiplier: isDeep ? DEEP_SCAN_MULTIPLIER : 1,
        },
      },
    })

    // A-M05: Decrement MinutePack.remainingMinutes atomically when consumption
    // spills into packs. The pool is consumed first; only the overflow reduces
    // pack balances. We decrement oldest-first (FIFO) matching the draw order.
    await decrementPackMinutes(workspaceId, minutes)
  } catch (error) {
    // P2002 = unique constraint violation — concurrent idempotent insert
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Idempotent replay of recordAgentMinutes", { idempotencyKey })
      return { created: false, minutes: 0, idempotencyKey }
    }
    throw error
  }

  return { created: true, minutes, idempotencyKey }
}

/**
 * Decrement pack remaining minutes for a workspace, oldest-first (FIFO).
 *
 * A-M05: Called after recording agent_minutes to atomically reduce pack
 * balances. Only the overflow beyond the monthly pool consumes pack minutes;
 * the caller passes the total minutes consumed this tick, and this function
 * checks how many pool minutes remain before decrementing packs.
 */
async function decrementPackMinutes(workspaceId: string, _minutesConsumed: number): Promise<void> {
  // Get the current pool remaining to know how much spills into packs
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { workspaceId },
    select: { currentPeriodStart: true },
  })
  const cycleStart = billingAccount?.currentPeriodStart
  if (!cycleStart) return // No cycle → can't compute pool remaining

  const [grantRecords, consumeRecords] = await Promise.all([
    prisma.usageRecord.findMany({
      where: { workspaceId, kind: { in: ["pool_grant", "trial_grant"] }, deletedAt: null, cycleStart: { gte: cycleStart } },
      select: { quantity: true },
    }),
    prisma.usageRecord.findMany({
      where: { workspaceId, kind: "agent_minutes", deletedAt: null, cycleStart: { gte: cycleStart } },
      select: { quantity: true },
    }),
  ])

  const poolMinutes = grantRecords.reduce((s, r) => s + r.quantity, 0)
  const poolConsumed = consumeRecords.reduce((s, r) => s + r.quantity, 0)

  // Only the overflow beyond pool remaining consumes pack minutes.
  // The just-recorded minutes are included in poolConsumed, so poolRemaining
  // already reflects the post-debit state. If poolConsumed > poolMinutes,
  // the overflow is the pack consumption.
  const packSpillover = Math.max(0, poolConsumed - poolMinutes)
  if (packSpillover <= 0) return

  // Decrement oldest packs first (FIFO draw order)
  const packs = await prisma.minutePack.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      remainingMinutes: { gt: 0 },
    },
    orderBy: { purchasedAt: "asc" },
    select: { id: true, remainingMinutes: true },
  })

  let toDecrement = packSpillover
  for (const pack of packs) {
    if (toDecrement <= 0) break
    const decrementAmount = Math.min(pack.remainingMinutes, toDecrement)
    await prisma.minutePack.update({
      where: { id: pack.id },
      data: { remainingMinutes: { decrement: decrementAmount } },
    })
    toDecrement -= decrementAmount
  }
}
