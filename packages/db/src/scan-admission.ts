import type { DeterminismMode } from "@lyrashield/types"
import type { Prisma, Scan } from "./generated/prisma"
import type { CreateScanParams, ScanAdmissionOptions, ScanTransaction } from "./scan-service-types"
import { buildAdmittedScanPlan, computeScanExecutionPlanHash } from "./scan-execution-plan"
import { bindDelegatedScanProvenance } from "./delegated-scan-provenance"
import { createScanCapacity } from "./scan-capacity"
import { persistShadowScanDispatchAdmission } from "./scan-dispatch-admission"

/** Persist the admitted identity only after createScan holds its shared locks. */
export async function persistAdmittedScan(
  tx: ScanTransaction,
  params: CreateScanParams,
  targetType: string,
  determinismMode: DeterminismMode,
  sponsorAccountId: string | null,
  admissionOptions: ScanAdmissionOptions
): Promise<Scan> {
  // Build the authoritative execution plan from trusted inputs (the stored
  // target's type, the canonical profile registry, resolved provenance) and
  // persist it ONCE with the scan row — before queue publication. Updates
  // require a new scan; the queue carries scan identity only.
  const executionPlan = await buildAdmittedScanPlan(tx, params, targetType, determinismMode)
  const executionPlanHash = computeScanExecutionPlanHash(executionPlan)

  const scan = await tx.scan.create({
    data: {
      workspaceId: params.workspaceId,
      targetId: params.targetId,
      goal: params.goal as Scan["goal"],
      mode: (params.mode ?? "QUICK") as Scan["mode"],
      policyId: params.policyId ?? null,
      status: "QUEUED",
      accountingVersion: 2,
      triggerType: params.triggerType ?? "manual",
      determinismMode,
      createdById: params.createdById,
      sponsorAccountId: sponsorAccountId ?? params.createdById,
      delegatedConnectionId: params.delegatedConnection?.connectionId ?? null,
      delegatedAuthorizationVersion: params.delegatedConnection?.authorizationVersion ?? null,
      executionPlan: executionPlan as Prisma.InputJsonValue,
      executionPlanHash,
    },
  })
  if (params.delegatedOperation) {
    await bindDelegatedScanProvenance(tx, {
      workspaceId: params.workspaceId,
      scanId: scan.id,
      targetId: params.targetId,
      executionPlanHash,
      admission: params.delegatedOperation,
    })
  }
  await createScanCapacity(tx, scan, executionPlan.capabilities.includes("engine"))
  await tx.scanEvent.create({
    data: {
      scanId: scan.id,
      stage: "queued",
      level: "info",
      message: "Scan queued",
      metadata: {
        targetId: params.targetId,
        goal: params.goal,
        mode: params.mode ?? "QUICK",
      },
    },
  })
  if (admissionOptions.dispatchAuthority === "shadow")
    await persistShadowScanDispatchAdmission(tx, scan, params.focus)
  return scan
}
