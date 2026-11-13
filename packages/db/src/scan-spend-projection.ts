import type { Scan } from "./generated/prisma"
import { readScanCapacity, type ScanCapacityProjection } from "./scan-capacity"
import { withWorkspaceRLS } from "./rls"
import { decimalString, planFacts } from "./scan-spend-facts"

export type SpendValue =
  | {
      state: "known"
      amountUsd: string
      source: "ADMITTED_PROVIDER_CEILING" | "RECONCILED_PROVIDER_USAGE"
      observedAt: string
    }
  | { state: "not_applicable"; reason: string }
  | {
      state: "unavailable"
      reason:
        | "LEGACY_SCAN"
        | "SETTLEMENT_PENDING"
        | "PROVIDER_USAGE_UNRECONCILED"
        | "NOT_AUTHORIZED"
        | "NO_PROVIDER_DOLLAR_RESERVATION"
    }

export interface ScanSpendProjection {
  maximum: SpendValue
  consumed: SpendValue
  reserved: SpendValue
  agentMinutes: {
    funded: number
    charged: number
    absorbed: number
  } | null
}

export interface SpendScanInput {
  id: string
  workspaceId: string
  createdById: string
  sponsorAccountId: string | null
  status: string
  accountingVersion: number | null
  accountingSettledAt: Date | null
  billedCostUsd: unknown
  actualCostCents: number | null
  createdAt: Date
  updatedAt: Date
  executionPlan: unknown
}

/**
 * Pure spend projection. Monetary reservation is deliberately unavailable:
 * the current schema reserves agent minutes, not provider dollars. A null
 * receipt is unknown, never zero.
 */
export function buildScanSpendProjection(input: {
  actorUserId: string
  canManageBilling: boolean
  scan: SpendScanInput
  capacity: ScanCapacityProjection | null
}): ScanSpendProjection | null {
  const sponsorAccountId = input.scan.sponsorAccountId ?? input.scan.createdById
  if (!input.canManageBilling && input.actorUserId !== sponsorAccountId) return null

  const plan = planFacts(input.scan.executionPlan)
  const billed = decimalString(input.scan.billedCostUsd)
  const legacyActual = decimalString(
    input.scan.actualCostCents === null ? null : input.scan.actualCostCents / 100
  )
  const contradictoryReceipt =
    plan.applicability === "deterministic" &&
    [billed, legacyActual].some((amount) => amount !== null && Number(amount) > 0)
  const applicability = contradictoryReceipt ? "unavailable" : plan.applicability
  const maximum: SpendValue =
    applicability === "deterministic"
      ? {
          state: "known",
          amountUsd: "0",
          source: "ADMITTED_PROVIDER_CEILING",
          observedAt: input.scan.createdAt.toISOString(),
        }
      : applicability === "engine" && plan.maximumUsd !== null
        ? {
            state: "known",
            amountUsd: plan.maximumUsd,
            source: "ADMITTED_PROVIDER_CEILING",
            observedAt: input.scan.createdAt.toISOString(),
          }
        : {
            state: "unavailable",
            reason:
              input.scan.accountingVersion === 2 ? "PROVIDER_USAGE_UNRECONCILED" : "LEGACY_SCAN",
          }

  const consumed: SpendValue =
    billed !== null
      ? {
          state: "known",
          amountUsd: billed,
          source: "RECONCILED_PROVIDER_USAGE",
          observedAt: input.scan.updatedAt.toISOString(),
        }
      : legacyActual !== null
        ? {
            state: "known",
            amountUsd: legacyActual,
            source: "RECONCILED_PROVIDER_USAGE",
            observedAt: input.scan.updatedAt.toISOString(),
          }
        : applicability === "deterministic"
          ? {
              state: "known",
              amountUsd: "0",
              source: "RECONCILED_PROVIDER_USAGE",
              observedAt: input.scan.updatedAt.toISOString(),
            }
          : {
              state: "unavailable",
              reason:
                input.scan.accountingVersion !== 2
                  ? "LEGACY_SCAN"
                  : input.scan.status === "RUNNING" ||
                      input.scan.status === "QUEUED" ||
                      input.scan.status === "PREFLIGHT" ||
                      input.scan.status === "VERIFYING" ||
                      input.scan.accountingSettledAt === null
                    ? "SETTLEMENT_PENDING"
                    : "PROVIDER_USAGE_UNRECONCILED",
            }

  const reserved: SpendValue =
    applicability === "deterministic"
      ? { state: "not_applicable", reason: "This review does not invoke a paid provider." }
      : {
          state: "unavailable",
          reason: applicability === "engine" ? "NO_PROVIDER_DOLLAR_RESERVATION" : "LEGACY_SCAN",
        }

  return {
    maximum,
    consumed,
    reserved,
    agentMinutes: input.capacity
      ? {
          funded: input.capacity.fundedMinutes,
          charged: input.capacity.chargedMinutes,
          absorbed: input.capacity.absorbedMinutes,
        }
      : null,
  }
}

export async function getScanSpendProjection(params: {
  workspaceId: string
  scanId: string
  actorUserId: string
  canManageBilling: boolean
}): Promise<ScanSpendProjection | null> {
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: params.scanId, workspaceId: params.workspaceId, deletedAt: null },
    })
    if (!scan) return null
    const capacity = await readScanCapacity(tx, scan as Scan)
    return buildScanSpendProjection({
      actorUserId: params.actorUserId,
      canManageBilling: params.canManageBilling,
      scan,
      capacity,
    })
  })
}
