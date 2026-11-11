import {
  completeScanWithScore,
  prisma,
  qualifyReferralForWorkspace,
  updateScanStatus,
  verifyStoredManifestChecksum,
  withWorkspaceRLS,
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
      resultManifest: { select: { id: true, checksum: true, checksumInput: true, manifest: true } },
      events: {
        where: { stage: "billable_boundary" },
        select: { id: true },
        take: 1,
      },
    },
  })
  const resultManifest = pendingFinalization?.resultManifest
  const active =
    pendingFinalization &&
    ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"].includes(pendingFinalization.status)
  const checksum = resultManifest && active ? verifyStoredManifestChecksum(resultManifest) : null
  if (checksum === "MISMATCH")
    throw new Error("Stored scan result manifest failed checksum verification")
  const terminalOutcome = storedTerminalOutcome(resultManifest?.manifest)
  if (
    active &&
    pendingFinalization.status !== "VERIFYING" &&
    checksum === "MATCH" &&
    terminalOutcome &&
    resultManifest
  ) {
    // Older retry paths could regress a scan after its immutable manifest committed.
    // Restore only the exact checked checkpoint, without rerunning preflight or the engine.
    await withWorkspaceRLS(workspaceId, async (tx) => {
      const changed = await tx.scan.updateMany({
        where: {
          id: scanId,
          workspaceId,
          status: pendingFinalization.status,
          resultManifest: { is: { id: resultManifest.id, checksum: resultManifest.checksum } },
        },
        data: { status: "VERIFYING" },
      })
      if (changed.count !== 1) throw new Error("Scan changed during manifest recovery")
      await tx.scanEvent.create({
        data: {
          scanId,
          stage: "verifying",
          level: "info",
          message: "Restored finalization from the stored result manifest",
        },
      })
    })
    pendingFinalization.status = "VERIFYING"
  }
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
    ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"].includes(pendingFinalization?.status ?? "") &&
    pendingFinalization?.events?.length
  ) {
    const interruptedMessage =
      "Provider-billable analysis was already claimed and was not replayed automatically"
    // Stalled delivery does not prove its predecessor stopped. Leave its scan,
    // reservation and working directory intact; the durable marker holds ambiguous execution for review.
    return {
      status: "failed",
      errorCategory: "BILLABLE_PHASE_INTERRUPTED",
      errorMessage: interruptedMessage,
    }
  }
  return null
}
