import { withWorkspaceRLS, updateScanStatus, type ScanStatus } from "@lyrashield/db"
import type { ScanJobResult } from "../../types"
import { refreshGateVerdictAfterTerminalScan } from "./lifecycle-utils"

/** Missing soft-deleted rows stop provider work just like visible cancellation. */
export function createScanCancellationPoller(scanId: string, workspaceId: string) {
  const cacheMs = 2000
  let checkedAt = 0
  let cancelled = false
  return async (force = false): Promise<boolean> => {
    const now = Date.now()
    if (!force && now - checkedAt < cacheMs) return cancelled
    const current = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.scan.findUnique({
        where: { id: scanId, workspaceId },
        select: { status: true },
      })
    )
    cancelled = !current || current.status === "CANCELLED"
    checkedAt = now
    return cancelled
  }
}

/** Private recovery recognizes a retained cancelled scan without making it public. */
export async function readScanTerminalState(scanId: string, workspaceId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const visible = await tx.scan.findUnique({
      where: { id: scanId, workspaceId },
      select: { status: true, summary: true, errorCategory: true, errorMessage: true },
    })
    if (visible) return visible
    const rows = await tx.$queryRaw<
      Array<{
        status: ScanStatus
        summary: string | null
        errorCategory: string | null
        errorMessage: string | null
      }>
    >`
      SELECT "status", "summary", "errorCategory", "errorMessage" FROM "Scan"
      WHERE "id" = ${scanId} AND "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NOT NULL AND "status" = 'CANCELLED'
      LIMIT 1`
    return rows[0] ?? null
  })
}

/** Execution denial occurs after RUNNING, so persist its actual terminal cause. */
export async function finalizeExecutionDenial(
  scanId: string,
  workspaceId: string,
  targetId: string,
  result: ScanJobResult
): Promise<ScanJobResult> {
  if (result.status === "failed" && result.errorCategory !== "CANCELLED") {
    // The guarded status transition preserves cancellation racing this denial.
    await updateScanStatus(scanId, "FAILED", {
      errorCategory: result.errorCategory,
      errorMessage: result.errorMessage,
    })
    await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
  }
  return result
}
