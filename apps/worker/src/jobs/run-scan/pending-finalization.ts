import {
  completeScanWithScore,
  prisma,
  qualifyReferralForWorkspace,
  updateScanStatus,
  type ScanStatus,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { completeRetestsForScan } from "../../engine/result-integrity"
import type { ScanJobResult } from "../../types"
import {
  refreshGateVerdictAfterTerminalScan,
  reportInterruptedSettlement,
  storedTerminalOutcome,
} from "./lifecycle-utils"

export async function resumePendingScanFinalization(params: {
  scanId: string
  workspaceId: string
  targetId: string | null
}): Promise<ScanJobResult | null> {
  const { scanId, workspaceId, targetId } = params

  // A manifest is the immutable checkpoint after findings and retests have
  // been persisted. If an infrastructure error interrupted only the final
  // score transition, resume that transition without replaying a billable
  // scan or comparing a fresh result against the original manifest.
  const pendingFinalization = await prisma.scan.findUnique({
    where: { id: scanId },
    select: {
      status: true,
      summary: true,
      errorCategory: true,
      errorMessage: true,
      actualCostCents: true,
      resultManifest: { select: { id: true, manifest: true } },
      events: {
        where: { stage: "billable_boundary" },
        select: { id: true },
        take: 1,
      },
    },
  })
  const terminalOutcome = storedTerminalOutcome(pendingFinalization?.resultManifest?.manifest)
  if (pendingFinalization?.status === "FAILED") {
    return {
      status: "failed",
      errorCategory: pendingFinalization.errorCategory ?? "INTERNAL_ERROR",
      errorMessage: pendingFinalization.errorMessage ?? "Scan failed; paid work was not replayed",
    }
  }
  if (pendingFinalization?.status === "COMPLETED") {
    await reportInterruptedSettlement(workspaceId, scanId)
    return { status: "completed", summary: pendingFinalization.summary ?? "Scan completed" }
  }
  if (pendingFinalization?.status === "PARTIAL") {
    await reportInterruptedSettlement(workspaceId, scanId)
    return {
      status: "failed",
      errorCategory: pendingFinalization.errorCategory ?? "PARTIAL",
      errorMessage: pendingFinalization.errorMessage ?? "Partial findings preserved",
    }
  }
  if (
    pendingFinalization?.resultManifest &&
    ["RUNNING", "VERIFYING"].includes(pendingFinalization.status) &&
    terminalOutcome &&
    terminalOutcome.status !== "COMPLETED"
  ) {
    await completeRetestsForScan({ scanId, workspaceId })
    await updateScanStatus(scanId, terminalOutcome.status as ScanStatus, {
      ...(terminalOutcome.errorCategory ? { errorCategory: terminalOutcome.errorCategory } : {}),
      ...(terminalOutcome.errorMessage ? { errorMessage: terminalOutcome.errorMessage } : {}),
      ...(pendingFinalization.actualCostCents !== null
        ? { actualCostCents: pendingFinalization.actualCostCents }
        : {}),
    })
    return {
      status: "failed",
      errorCategory: terminalOutcome.errorCategory ?? terminalOutcome.status,
      errorMessage: terminalOutcome.errorMessage ?? "Scan did not complete successfully",
    }
  }
  if (pendingFinalization?.status === "VERIFYING" && pendingFinalization.resultManifest) {
    if (pendingFinalization.errorCategory === "BUDGET_EXCEEDED") {
      await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
        errorCategory: "BUDGET_EXCEEDED",
        errorMessage: pendingFinalization.errorMessage ?? "Protected run limit reached",
        ...(pendingFinalization.actualCostCents !== null
          ? { actualCostCents: pendingFinalization.actualCostCents }
          : {}),
      })
      return {
        status: "failed",
        errorCategory: "BUDGET_EXCEEDED",
        errorMessage: "Protected run limit reached",
      }
    }
    // The manifest is persisted before retest finalization in the normal
    // path, so a crash between the two must resume pending retests from the
    // stored receipt evidence before scoring; otherwise retest validation
    // would be skipped silently. Nothing here invokes the engine or reruns
    // scanners, so billable work is never replayed.
    await completeRetestsForScan({ scanId, workspaceId })
    await completeScanWithScore(scanId, workspaceId, pendingFinalization.summary)
    await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
    try {
      await qualifyReferralForWorkspace(workspaceId)
    } catch (referralError) {
      logger.warn("Failed to qualify referral after resumed scan completion", {
        scanId,
        error: referralError instanceof Error ? referralError.message : String(referralError),
      })
    }
    return { status: "completed", summary: pendingFinalization.summary ?? "Scan completed" }
  }
  if (
    ["RUNNING", "VERIFYING"].includes(pendingFinalization?.status ?? "") &&
    pendingFinalization?.events?.length
  ) {
    const interruptedMessage =
      "Provider-billable analysis was interrupted and was not replayed automatically"
    await updateScanStatus(scanId, "FAILED" as ScanStatus, {
      errorCategory: "BILLABLE_PHASE_INTERRUPTED",
      errorMessage: interruptedMessage,
    })
    return {
      status: "failed",
      errorCategory: "BILLABLE_PHASE_INTERRUPTED",
      errorMessage: interruptedMessage,
    }
  }
  return null
}
