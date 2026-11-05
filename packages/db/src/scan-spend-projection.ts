import type { Scan } from "./generated/prisma"
import { readScanCapacity, type ScanCapacityProjection } from "./scan-capacity"
import { withWorkspaceRLS } from "./rls"

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

interface SpendScanInput {
  id: string
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

function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "object" && value !== null && "toString" in value) {
    const rendered = String(value)
    if (rendered && rendered !== "[object Object]") return rendered
  }
  return null
}

function planFacts(value: unknown): { engineBacked: boolean; maximumUsd: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { engineBacked: false, maximumUsd: null }
  }
  const plan = value as {
    capabilities?: unknown
    limits?: { maxBudgetUsd?: unknown }
  }
  const engineBacked =
    Array.isArray(plan.capabilities) && plan.capabilities.some((item) => item === "engine")
  const maximum = plan.limits?.maxBudgetUsd
  return {
    engineBacked,
    maximumUsd:
      typeof maximum === "number" && Number.isFinite(maximum) && maximum >= 0
        ? String(maximum)
        : null,
  }
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
  const maximum: SpendValue = !plan.engineBacked
    ? {
        state: "known",
        amountUsd: "0",
        source: "ADMITTED_PROVIDER_CEILING",
        observedAt: input.scan.createdAt.toISOString(),
      }
    : plan.maximumUsd !== null
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

  const billed = decimalString(input.scan.billedCostUsd)
  const legacyActual = decimalString(
    input.scan.actualCostCents === null ? null : input.scan.actualCostCents / 100
  )
  const consumed: SpendValue = !plan.engineBacked
    ? {
        state: "known",
        amountUsd: "0",
        source: "RECONCILED_PROVIDER_USAGE",
        observedAt: input.scan.updatedAt.toISOString(),
      }
    : billed !== null
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

  const reserved: SpendValue = plan.engineBacked
    ? { state: "unavailable", reason: "NO_PROVIDER_DOLLAR_RESERVATION" }
    : { state: "not_applicable", reason: "This review does not invoke a paid provider." }

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
