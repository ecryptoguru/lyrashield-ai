import type { CreateScanParams, ScanTransaction } from "./scan-service-types"
import { canonicalizeJson, sha256Sync } from "@lyrashield/security/webmcp"
import {
  buildScanExecutionPlan,
  ScanExecutionPlanInputError,
  SCAN_EXECUTION_PLAN_VERSION,
  ScanExecutionPlanSchema,
  type ScanExecutionPlan,
} from "@lyrashield/types"

/**
 * Canonical JSON + sha256 for the authoritative scan execution plan. The hash
 * is integrity/provenance only — it proves the stored plan is the one the
 * server wrote; it is not a signature and not an authorization substitute.
 * Deterministic canonical JSON means equal plans hash identically regardless
 * of JSON key order.
 */
export function canonicalizeScanExecutionPlan(plan: ScanExecutionPlan): string {
  return canonicalizeJson(plan)
}

/**
 * The platform budget ceiling with the same default and fail-closed validation
 * as `PLATFORM_MAX_SCAN_BUDGET_USD`, read without importing the whole
 * application env contract. This module is consumed by the control plane, which
 * must not require web/auth secrets to verify a stored plan.
 */
function platformMaxBudgetUsd(): number {
  const raw = process.env.PLATFORM_MAX_SCAN_BUDGET_USD?.trim()
  if (!raw) return 50
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 1000)
    throw new ScanExecutionPlanInputError("Platform scan budget configuration is invalid.")
  return value
}

export function computeScanExecutionPlanHash(plan: ScanExecutionPlan): string {
  return sha256Sync(canonicalizeScanExecutionPlan(plan))
}

export type StoredExecutionPlanCheck =
  { ok: true; plan: ScanExecutionPlan } | { ok: false; errorCategory: string; errorMessage: string }

/**
 * Validate a stored `Scan.executionPlan` against its `executionPlanHash`.
 * Callers decide how to treat a NULL plan (legacy rows) — this function only
 * verifies rows that carry one. Any malformed, unsupported-version, or
 * tampered plan fails closed with a named category; the worker must never
 * repair, widen, or substitute the recorded plan.
 */
export function verifyStoredScanExecutionPlan(
  storedPlan: unknown,
  storedHash: string | null | undefined
): StoredExecutionPlanCheck {
  if (storedPlan === null || storedPlan === undefined) {
    return {
      ok: false,
      errorCategory: "SCAN_PLAN_INVALID",
      errorMessage: "Scan execution plan is missing",
    }
  }
  if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) {
    return {
      ok: false,
      errorCategory: "SCAN_PLAN_INTEGRITY",
      errorMessage: "Scan execution plan hash is missing or malformed",
    }
  }

  const parsed = ScanExecutionPlanSchema.safeParse(storedPlan)
  if (!parsed.success) {
    const version =
      typeof storedPlan === "object" && storedPlan !== null
        ? (storedPlan as { version?: unknown }).version
        : undefined
    if (typeof version === "string" && version !== SCAN_EXECUTION_PLAN_VERSION) {
      return {
        ok: false,
        errorCategory: "SCAN_PLAN_VERSION_UNSUPPORTED",
        errorMessage: `Unsupported scan execution plan version: ${version}`,
      }
    }
    return {
      ok: false,
      errorCategory: "SCAN_PLAN_INVALID",
      errorMessage: "Stored scan execution plan failed contract validation",
    }
  }

  if (computeScanExecutionPlanHash(parsed.data) !== storedHash) {
    return {
      ok: false,
      errorCategory: "SCAN_PLAN_HASH_MISMATCH",
      errorMessage: "Stored scan execution plan does not match its recorded hash",
    }
  }

  return { ok: true, plan: parsed.data }
}

export async function buildAdmittedScanPlan(
  tx: ScanTransaction,
  params: CreateScanParams,
  targetType: string,
  determinismMode: string
) {
  const policy =
    params.verifyWorkspaceDefaultPolicy || params.policyId
      ? await tx.policy.findFirst({
          where: {
            workspaceId: params.workspaceId,
            deletedAt: null,
            ...(params.verifyWorkspaceDefaultPolicy
              ? { name: "Default Policy" }
              : { id: params.policyId }),
          },
          orderBy: params.verifyWorkspaceDefaultPolicy
            ? [{ createdAt: "asc" }, { id: "asc" }]
            : undefined,
          select: { id: true, maxBudgetUsd: true },
        })
      : null
  if (params.verifyWorkspaceDefaultPolicy && policy?.id !== params.policyId)
    throw new ScanExecutionPlanInputError(
      "The workspace default scan policy changed. Check eligibility before starting a new review."
    )
  if (params.policyId && !policy)
    throw new ScanExecutionPlanInputError("Assigned scan policy is unavailable.")
  return buildScanExecutionPlan({
    policyMaxBudgetUsd: policy?.maxBudgetUsd?.toNumber(),
    platformMaxBudgetUsd: platformMaxBudgetUsd(),
    engineBudgetCeilingUsd: params.engineBudgetCeilingUsd,
    workflow: params.workflow,
    targetType,
    mode: params.mode ?? "QUICK",
    deterministicOnly: determinismMode === "targeted_scanner",
    ...(params.source ? { source: params.source } : {}),
    ...(params.attachmentIds ? { attachmentIds: params.attachmentIds } : {}),
    ...(params.authorizationRef ? { authorizationRef: params.authorizationRef } : {}),
  })
}
