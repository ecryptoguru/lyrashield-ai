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
