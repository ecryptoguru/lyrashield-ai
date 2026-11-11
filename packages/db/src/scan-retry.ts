import type { ScanStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { getWorkspaceContext } from "./extension"
import { withWorkspaceRLS } from "./rls"
import { readLockedBillableScan, ScanBillableClaimError } from "./scan-billable-claim"

/**
 * Statuses a retrying job may regress to QUEUED. Anything outside this set is
 * terminal or paused (REQUIRES_APPROVAL) and must not be silently requeued —
 * the caller gets `requeued: false` and decides whether retrying is still
 * meaningful.
 */
const REQUEUEABLE_SCAN_STATUSES: ScanStatus[] = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"]

export type RequeueScanForRetryResult =
  { requeued: true; fromStatus: ScanStatus } | { requeued: false; currentStatus: ScanStatus | null }

/**
 * W2.2 — recorded retry requeue.
 *
 * BullMQ retries — including stalled-job recovery after a worker restart —
 * regress the scan row to QUEUED while the queue owns re-execution. Doing
 * that with a bare UPDATE loses the step: the interrupted PREFLIGHT/RUNNING/
 * VERIFYING step would vanish from the timeline with no trace of why. This
 * helper performs the regression and records the `queued` step event with
 * attempt and failure context in the same workspace-scoped transaction, so
 * the persisted lifecycle stays complete and deterministic across restarts.
 *
 * The status guard is part of the row write: a scan that raced to a terminal
 * or paused state is never requeued, and no event claims a requeue that did
 * not happen.
 */
export async function requeueScanForRetry(params: {
  scanId: string
  workspaceId?: string
  attempt: number
  maxAttempts: number
  clearStartedAt?: boolean
  errorCategory?: string
  errorMessage?: string
}): Promise<RequeueScanForRetryResult> {
  const workspaceId = params.workspaceId ?? getWorkspaceContext()
  if (!workspaceId) {
    throw new Error(`workspaceId or workspace context is required for requeueScanForRetry`)
  }

  const outcome = await withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await readLockedBillableScan(tx, workspaceId, params.scanId)
    if (!scan) return { requeued: false as const, currentStatus: null }
    const currentStatus = scan.status as ScanStatus
    if (scan.events.length) throw new ScanBillableClaimError()
    if (!REQUEUEABLE_SCAN_STATUSES.includes(currentStatus)) {
      return { requeued: false as const, currentStatus }
    }
    const result = await tx.scan.updateMany({
      where: { id: params.scanId, status: currentStatus },
      data: { status: "QUEUED", ...(params.clearStartedAt ? { startedAt: null } : {}) },
    })
    if (result.count !== 1) {
      // Lost a race to a status change — re-read so the caller sees the truth.
      const latest = await tx.scan.findUnique({
        where: { id: params.scanId },
        select: { status: true },
      })
      return { requeued: false as const, currentStatus: (latest?.status as ScanStatus) ?? null }
    }
    await tx.scanEvent.create({
      data: {
        scanId: params.scanId,
        stage: "queued",
        level: "info",
        message: `Scan requeued for retry (attempt ${params.attempt} of ${params.maxAttempts})`,
        metadata: {
          transition: "requeue",
          fromStatus: currentStatus,
          attempt: params.attempt,
          maxAttempts: params.maxAttempts,
          ...(params.errorCategory ? { errorCategory: params.errorCategory } : {}),
          ...(params.errorMessage ? { errorMessage: params.errorMessage.slice(0, 500) } : {}),
        },
      },
    })
    return { requeued: true as const, fromStatus: currentStatus }
  })

  if (outcome.requeued) {
    logger.info("Scan requeued for retry", {
      scanId: params.scanId,
      from: outcome.fromStatus,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
    })
  }
  return outcome
}
