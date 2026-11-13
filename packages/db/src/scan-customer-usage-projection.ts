import { withWorkspaceRLS } from "./rls"
import type { SpendScanInput } from "./scan-spend-projection"
import { decimalString, planFacts } from "./scan-spend-facts"

export interface CustomerScanUsageProjection {
  state: "reconciled" | "pending" | "not_applicable" | "unavailable"
  chargedMinutes: number | null
}

interface AgentMinuteReceipt {
  accountId: string | null
  workspaceId: string | null
  idempotencyKey: string | null
  kind: string
  deletedAt: Date | null
  quantity: number
  metadata: unknown
}

/** Customer usage is derived only from a receipt bound to the sponsor account. */
export function buildCustomerScanUsageProjection(input: {
  actorUserId: string
  scan: SpendScanInput
  receipt: AgentMinuteReceipt | null
}): CustomerScanUsageProjection | null {
  const { scan, receipt } = input
  const accountId = scan.sponsorAccountId ?? scan.createdById
  // Workspace billing permission is not authority over another user's account.
  if (input.actorUserId !== accountId) return null

  if (receipt) {
    const metadata = receipt.metadata
    const valid =
      receipt.accountId === accountId &&
      receipt.workspaceId === scan.workspaceId &&
      receipt.idempotencyKey === `${scan.workspaceId}:${scan.id}:engine_run` &&
      receipt.kind === "agent_minutes" &&
      receipt.deletedAt === null &&
      Number.isSafeInteger(receipt.quantity) &&
      receipt.quantity >= 0 &&
      metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      "scanId" in metadata &&
      metadata.scanId === scan.id &&
      "accountId" in metadata &&
      metadata.accountId === accountId
    return valid
      ? { state: "reconciled", chargedMinutes: receipt.quantity }
      : { state: "unavailable", chargedMinutes: null }
  }

  const plan = planFacts(scan.executionPlan)
  const billed = decimalString(scan.billedCostUsd)
  const providerCostRecorded =
    (billed !== null && Number(billed) > 0) ||
    (scan.actualCostCents !== null && scan.actualCostCents > 0)
  if (plan.applicability === "deterministic" && !providerCostRecorded) {
    return { state: "not_applicable", chargedMinutes: 0 }
  }
  if (
    plan.applicability === "engine" &&
    scan.accountingVersion === 2 &&
    (scan.accountingSettledAt === null ||
      ["RUNNING", "QUEUED", "PREFLIGHT", "VERIFYING"].includes(scan.status))
  ) {
    return { state: "pending", chargedMinutes: null }
  }
  return { state: "unavailable", chargedMinutes: null }
}

/** Bind the ledger read to the persisted sponsor, then recheck it in the same snapshot. */
export async function getCustomerScanUsageProjection(params: {
  workspaceId: string
  scanId: string
  actorUserId: string
}): Promise<CustomerScanUsageProjection | null> {
  const original = await withWorkspaceRLS(params.workspaceId, (tx) =>
    tx.scan.findFirst({
      where: { id: params.scanId, workspaceId: params.workspaceId, deletedAt: null },
    })
  )
  if (!original) return null
  const accountId = original.sponsorAccountId ?? original.createdById
  if (params.actorUserId !== accountId) return null

  return withWorkspaceRLS(
    params.workspaceId,
    async (tx) => {
      const scan = await tx.scan.findFirst({
        where: { id: params.scanId, workspaceId: params.workspaceId, deletedAt: null },
      })
      if (!scan || (scan.sponsorAccountId ?? scan.createdById) !== accountId) return null
      const receipt = await tx.usageRecord.findUnique({
        where: { idempotencyKey: `${params.workspaceId}:${scan.id}:engine_run`, accountId },
        select: {
          accountId: true,
          workspaceId: true,
          idempotencyKey: true,
          kind: true,
          deletedAt: true,
          quantity: true,
          metadata: true,
        },
      })
      return buildCustomerScanUsageProjection({ ...params, scan, receipt })
    },
    { accountId }
  )
}
