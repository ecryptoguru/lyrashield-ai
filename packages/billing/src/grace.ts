/**
 * Grace period state machine.
 *
 * When a scan's agent-minute balance hits 0 mid-scan, the workspace enters
 * a grace period of 15 minutes (wall-clock). During grace, the scan continues
 * running. If grace is exceeded, the scan is stopped with STOPPED_BUDGET.
 *
 * Grace resets on cycle rollover (new billing period).
 *
 * State is tracked on the Workspace model:
 * - graceUsedMs: cumulative grace used in the current cycle
 * - graceCycleStart: when the current grace cycle started
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

/** Maximum grace period per billing cycle, in milliseconds. */
export const GRACE_CAP_MS = 15 * 60 * 1000 // 15 minutes

export interface GraceState {
  /** Whether the workspace is currently in a grace period. */
  inGrace: boolean
  /** Grace milliseconds used in the current cycle. */
  usedMs: number
  /** Grace milliseconds remaining in the current cycle. */
  remainingMs: number
  /** When the current grace cycle started. */
  cycleStart: Date | null
  /** Whether grace has been exceeded. */
  exceeded: boolean
}

/**
 * Get the current grace state for a workspace.
 */
export async function getGraceState(workspaceId: string): Promise<GraceState> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { graceUsedMs: true, graceCycleStart: true },
  })

  if (!workspace) {
    return {
      inGrace: false,
      usedMs: 0,
      remainingMs: GRACE_CAP_MS,
      cycleStart: null,
      exceeded: false,
    }
  }

  const usedMs = workspace.graceUsedMs
  const remainingMs = Math.max(0, GRACE_CAP_MS - usedMs)
  const exceeded = usedMs >= GRACE_CAP_MS

  return {
    inGrace: usedMs > 0 && !exceeded,
    usedMs,
    remainingMs,
    cycleStart: workspace.graceCycleStart,
    exceeded,
  }
}

/**
 * Enter or continue a grace period for a workspace.
 *
 * Called by the worker when balance <= 0 mid-scan. Returns whether
 * the scan should continue (grace available) or stop (grace exceeded).
 *
 * Uses an atomic increment to avoid the read-then-write race condition
 * where concurrent ticks could both read the same graceUsedMs and overwrite
 * each other's increment.
 *
 * @param workspaceId - The workspace ID
 * @param deltaMs     - Grace milliseconds consumed in this tick
 * @returns Whether the scan should continue
 */
export async function enterGrace(
  workspaceId: string,
  deltaMs: number
): Promise<{ shouldContinue: boolean; remainingMs: number }> {
  // A-M09: Use a conditional updateMany that checks the cap atomically.
  // This prevents concurrent ticks from each incrementing past the cap.
  // The WHERE clause ensures the increment only happens if graceUsedMs
  // is still below the cap, making the check-and-increment atomic.
  const result = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      graceUsedMs: { lt: GRACE_CAP_MS },
    },
    data: {
      graceUsedMs: { increment: deltaMs },
    },
  }).catch(() => ({ count: 0 }))

  if (result.count === 0) {
    // Either workspace not found, or grace cap already exceeded
    return { shouldContinue: false, remainingMs: 0 }
  }

  // Read the updated value to compute remaining
  const updated = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { graceUsedMs: true, graceCycleStart: true },
  })

  if (!updated) {
    return { shouldContinue: false, remainingMs: 0 }
  }

  // Ensure graceCycleStart is set if it was null (first grace entry).
  if (!updated.graceCycleStart) {
    await prisma.workspace.updateMany({
      where: { id: workspaceId, graceCycleStart: null },
      data: { graceCycleStart: new Date() },
    })
  }

  const newUsedMs = updated.graceUsedMs

  if (newUsedMs >= GRACE_CAP_MS) {
    // Grace exceeded — clamp to cap and signal stop
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { graceUsedMs: GRACE_CAP_MS },
    }).catch(() => {})

    logger.warn("Grace period exceeded — scan should stop", {
      workspaceId,
      graceUsedMs: GRACE_CAP_MS,
    })

    return { shouldContinue: false, remainingMs: 0 }
  }

  return {
    shouldContinue: true,
    remainingMs: GRACE_CAP_MS - newUsedMs,
  }
}

/**
 * Reset grace for a new billing cycle.
 *
 * Called by the monthly grant / subscription renewal flow.
 */
export async function resetGrace(workspaceId: string): Promise<void> {
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      graceUsedMs: 0,
      graceCycleStart: null,
    },
  })

  logger.info("Grace period reset for new cycle", { workspaceId })
}
