import { withWorkspaceRLS, updateScanStatus } from "@lyrashield/db"
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
