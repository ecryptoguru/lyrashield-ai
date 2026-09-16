import { hasPermission, PERMISSIONS } from "@lyrashield/auth/permissions"
import { evaluateScanEntitlement } from "@lyrashield/billing"
import { prisma, runWithAccountContext, updateScanStatus, type ScanStatus } from "@lyrashield/db"
import type { ScanJobData, ScanJobResult } from "../../types"
import { refreshGateVerdictAfterTerminalScan } from "./lifecycle-utils"
import type { StoredScanAuthority } from "./authority"

export async function verifyScanAdmission(params: {
  scanId: string
  workspaceId: string
  targetId: string | null
  mode: ScanJobData["mode"]
  engineBacked: boolean
  deterministicRetest: boolean
  scanRecord: StoredScanAuthority
}): Promise<{ ok: true } | { ok: false; result: ScanJobResult }> {
  const { scanId, workspaceId, targetId, mode, engineBacked, deterministicRetest, scanRecord } =
    params

  // All producers converge here, including schedules and retests. Recheck
  // revocation and billing before provider work; never switch a queued
  // scan to a different payer when workspace sponsorship changes.
  const creator = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: scanRecord.createdById, status: "active" },
    select: { role: true },
  })
  const executionPermission =
    scanRecord.triggerType === "schedule"
      ? PERMISSIONS.schedule.create
      : scanRecord.triggerType === "retest"
        ? PERMISSIONS.retest.create
        : PERMISSIONS.scan.create
  let admissionError: { errorCategory: string; errorMessage: string } | null = null
  if (!creator || !hasPermission(creator.role, executionPermission)) {
    admissionError = {
      errorCategory: "SCAN_AUTHORIZATION_REVOKED",
      errorMessage: "The scan creator no longer has permission to run this review.",
    }
  } else if (engineBacked && !deterministicRetest) {
    const entitlement = await runWithAccountContext(scanRecord.createdById, () =>
      evaluateScanEntitlement({ workspaceId, mode, sponsorAccountId: scanRecord.createdById })
    )
    if (!entitlement.allowed) {
      admissionError = {
        errorCategory: entitlement.code ?? "SCAN_ENTITLEMENT_UNAVAILABLE",
        errorMessage: entitlement.message ?? "The billing sponsor cannot run this review.",
      }
    } else if (entitlement.accountId !== (scanRecord.sponsorAccountId ?? scanRecord.createdById)) {
      admissionError = {
        errorCategory: "SCAN_SPONSOR_CHANGED",
        errorMessage:
          "Workspace billing sponsorship changed. Start a new review with the current sponsor.",
      }
    }
  }
  if (admissionError) {
    await updateScanStatus(scanId, "FAILED" as ScanStatus, admissionError)
    await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
    return { ok: false, result: { status: "failed", ...admissionError } }
  }
  return { ok: true }
}
