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

import { prisma, withWorkspaceRLS } from "@lyrashield/db"
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
  /**
   * Terminal outcome of the scan. Founder-confirmed billing rules (2026-08-29):
   * - "failed" scans are NEVER billed — the caller must not call this at all
   *   for a failed terminal state (no agent_minutes UsageRecord is written).
   * - "cancelled" scans bill for the period actually used, WITHOUT the
   *   1-minute floor. A cancel at 20 seconds bills 20 seconds' worth.
   *   Rounding rule (documented): minutes are whole-minute ceiling, so a
   *   cancel at 20s bills 1 minute; the difference vs. a normal scan is that
   *   the floor is not applied, i.e. ms<=0 bills 0 and there is no forced
   *   minimum. Sub-minute (per-second) billing is impractical because
   *   UsageRecord.quantity and all pool/pack arithmetic are integer minutes.
   * - "completed" (default) applies the 1-minute floor as before.
   */
  outcome?: "completed" | "failed" | "cancelled"
}

export interface RecordAgentMinutesResult {
  /** Whether a new usage record was created (false = idempotent replay). */
  created: boolean
  /** Minutes recorded (after multiplier, 0 on replay). */
  minutes: number
  /** The idempotency key used. */
  idempotencyKey: string
  /** Incremental minutes not covered by the monthly pool or minute packs. */
  overageMinutes: number
}

const MAX_TRANSACTION_ATTEMPTS = 3
type MeterTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

function isSerializationConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "P2034"
  )
}

function recordedOverageMinutes(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0
  const value = (metadata as Record<string, unknown>).overageMinutes
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
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

  // Failed scans are never billed (founder-confirmed 2026-08-29): refuse to
  // write any agent_minutes UsageRecord regardless of how much work completed.
  if (opts.outcome === "failed") {
    logger.info("Skipping agent-minute billing for failed scan", { workspaceId, scanId })
    return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0 }
  }

  if (ms <= 0) {
    return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0 }
  }

  // A-L06: Validate input bounds — reject oversized ms values.
  // A single tick should never represent more than 1 hour of wall-clock time;
  // larger values indicate a bug or abuse attempt.
  const MAX_TICK_MS = 60 * 60 * 1000 // 1 hour
  if (!Number.isFinite(ms) || ms > MAX_TICK_MS) {
    return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0 }
  }

  // Wall-clock ms → integer minutes.
  // - Normal/completed scans: ceiling with a 1-minute floor (min 1 if ms > 0).
  // - Cancelled scans: bill elapsed time only, NO floor (min 0). Rounding rule
  //   is whole-minute ceiling, so a cancel at 20s still rounds to 1 minute;
  //   the floor (which would also give 1) is simply not the mechanism. The
  //   distinction that matters is that a cancelled scan is not forced up to a
  //   minimum — only genuinely elapsed whole minutes are billed.
  const rawMinutes =
    opts.outcome === "cancelled"
      ? Math.ceil(ms / 60_000)
      : Math.max(1, Math.ceil(ms / 60_000))

  // Deep/Custom scans consume 3× minutes
  const isDeep = opts.mode === "DEEP" || opts.mode === "CUSTOM"
  const minutes = isDeep ? rawMinutes * DEEP_SCAN_MULTIPLIER : rawMinutes

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await withWorkspaceRLS(
        workspaceId,
        async (tx) => {
          // Serialize all usage-record and pack-balance mutations for one
          // workspace. Serializable transactions can still abort after waiting
          // for this lock, so P2034 is retried below.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`

          const existing = await tx.usageRecord.findUnique({
            where: { idempotencyKey },
            select: { id: true, metadata: true },
          })
          if (existing) {
            return {
              created: false,
              minutes: 0,
              idempotencyKey,
              overageMinutes: recordedOverageMinutes(existing.metadata),
            }
          }

          const overageMinutes = await recordMinutesAndDebitIncrementalSpillover(tx, {
            workspaceId,
            scanId,
            minutes,
            idempotencyKey,
            cycleStart: opts.cycleStart,
            mode: opts.mode,
            wallClockMs: ms,
            rawMinutes,
            multiplier: isDeep ? DEEP_SCAN_MULTIPLIER : 1,
          })

          return { created: true, minutes, idempotencyKey, overageMinutes }
        },
        { isolationLevel: "Serializable" }
      )
    } catch (error) {
      if (isSerializationConflict(error) && attempt < MAX_TRANSACTION_ATTEMPTS) {
        logger.warn("Retrying agent-minute transaction after serialization conflict", {
          workspaceId,
          idempotencyKey,
          attempt,
        })
        continue
      }

      // P2002 remains a safe replay fallback if legacy writers do not take the
      // workspace advisory lock.
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: string }).code === "P2002"
      ) {
        logger.debug("Idempotent replay of recordAgentMinutes", { idempotencyKey })
        return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0 }
      }
      throw error
    }
  }

  throw new Error("agent_minute_transaction_retry_exhausted")
}

/**
 * Record usage and decrement its incremental pack spillover oldest-first.
 *
 * The transaction and advisory lock are owned by recordAgentMinutes. Computing
 * both pre- and post-record spillover prevents each tick from re-debiting the
 * cumulative spillover already reflected in MinutePack.remainingMinutes.
 */
async function recordMinutesAndDebitIncrementalSpillover(
  tx: MeterTransaction,
  input: {
    workspaceId: string
    scanId: string
    minutes: number
    idempotencyKey: string
    cycleStart?: Date
    mode?: ScanMode
    wallClockMs: number
    rawMinutes: number
    multiplier: number
  }
): Promise<number> {
  const billingAccount = await tx.billingAccount.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { currentPeriodStart: true },
  })
  const cycleStart = billingAccount?.currentPeriodStart

  const [grantRecords, priorConsumeRecords] = cycleStart
    ? await Promise.all([
        tx.usageRecord.findMany({
          where: {
            workspaceId: input.workspaceId,
            kind: { in: ["pool_grant", "trial_grant"] },
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          select: { quantity: true },
        }),
        tx.usageRecord.findMany({
          where: {
            workspaceId: input.workspaceId,
            kind: "agent_minutes",
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          select: { quantity: true },
        }),
      ])
    : [[], []]

  const poolMinutes = grantRecords.reduce((sum, record) => sum + record.quantity, 0)
  const priorConsumed = priorConsumeRecords.reduce((sum, record) => sum + record.quantity, 0)
  const priorSpillover = Math.max(0, priorConsumed - poolMinutes)
  const nextSpillover = Math.max(0, priorConsumed + input.minutes - poolMinutes)
  const incrementalSpillover = nextSpillover - priorSpillover

  let toDecrement = incrementalSpillover
  if (toDecrement > 0) {
    const packs = await tx.minutePack.findMany({
      where: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        remainingMinutes: { gt: 0 },
      },
      orderBy: { purchasedAt: "asc" },
      select: { id: true, remainingMinutes: true },
    })

    for (const pack of packs) {
      if (toDecrement <= 0) break
      const decrementAmount = Math.min(pack.remainingMinutes, toDecrement)
      const result = await tx.minutePack.updateMany({
        where: {
          id: pack.id,
          workspaceId: input.workspaceId,
          deletedAt: null,
          remainingMinutes: { gte: decrementAmount },
        },
        data: { remainingMinutes: { decrement: decrementAmount } },
      })
      if (result.count !== 1) {
        throw new Error("minute_pack_balance_changed")
      }
      toDecrement -= decrementAmount
    }
  }

  await tx.usageRecord.create({
    data: {
      workspaceId: input.workspaceId,
      kind: "agent_minutes",
      quantity: input.minutes,
      idempotencyKey: input.idempotencyKey,
      cycleStart: input.cycleStart ?? cycleStart ?? null,
      metadata: {
        scanId: input.scanId,
        mode: input.mode ?? null,
        wallClockMs: input.wallClockMs,
        rawMinutes: input.rawMinutes,
        multiplier: input.multiplier,
        overageMinutes: toDecrement,
      },
    },
  })
  return toDecrement
}
