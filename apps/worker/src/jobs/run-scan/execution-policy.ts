import { assertColdDatabaseEpoch } from "../../cold-database-epoch"
import { resolveScanBudgetUsd } from "../../engine/command-builder"
import { withWorkspaceRLS, updateScanStatus, type ScanStatus } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { notifyScanFailed } from "../../notifications"

/** Effective amount plus the authority that narrowed this invocation. */
export function effectiveEngineBudget(
  mode: string,
  targetType: string,
  policyBudget: number | null | undefined,
  storedBudget: number | undefined
) {
  const current = resolveScanBudgetUsd(mode, policyBudget, targetType)
  if (storedBudget !== undefined && storedBudget < current)
    return { amount: storedBudget, source: "execution_plan" }
  return {
    amount: current,
    source: typeof policyBudget === "number" && policyBudget > 0 ? "policy" : "mode_default",
  }
}

export async function readExecutionPolicy(policyId: string | undefined, workspaceId: string) {
  return policyId
    ? await withWorkspaceRLS(workspaceId, (tx) =>
        tx.policy.findFirst({
          where: { id: policyId, workspaceId, deletedAt: null },
          select: {
            maxBudgetUsd: true,
            maxDurationMinutes: true,
            blockedPaths: true,
            allowedDomains: true,
            destructiveTestsAllowed: true,
          },
        })
      )
    : null
}

export async function failScanWithTimeout(
  workspaceId: string,
  scanId: string,
  timeoutMessage: string
) {
  await updateScanStatus(scanId, "FAILED" as ScanStatus, {
    errorCategory: "TIMEOUT",
    errorMessage: timeoutMessage,
  })
  try {
    await notifyScanFailed(workspaceId, scanId, timeoutMessage)
  } catch (notificationError) {
    logger.warn("Failed to send scan timeout notification", {
      scanId,
      error:
        notificationError instanceof Error ? notificationError.message : String(notificationError),
    })
  }
}

/** Confirm database incarnation and fresh cancellation state before handing inputs to the engine. */
export async function engineDispatchStatus(isScanCancelled: (force?: boolean) => Promise<boolean>) {
  await assertColdDatabaseEpoch()
  return isScanCancelled(true).catch(() => null)
}
