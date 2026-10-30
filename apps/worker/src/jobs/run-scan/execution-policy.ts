import { withWorkspaceRLS, updateScanStatus, type ScanStatus } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { notifyScanFailed } from "../../notifications"

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
