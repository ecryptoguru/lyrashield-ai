import { resolveScanProfile } from "@lyrashield/types"

/** Existing scan budget authority with the platform ceiling supplied by trusted configuration. */
export function resolveScanBudgetUsd(
  mode: string,
  policyMaxBudgetUsd: number | null | undefined,
  targetType: string,
  platformMaxScanBudgetUsd: number
): number {
  if (!Number.isFinite(platformMaxScanBudgetUsd) || platformMaxScanBudgetUsd <= 0)
    throw new Error("SCAN_PLATFORM_BUDGET_INVALID")
  const profile = resolveScanProfile({ targetType, mode })
  if (typeof policyMaxBudgetUsd === "number" && Number.isFinite(policyMaxBudgetUsd)) {
    if (policyMaxBudgetUsd === 0) return 0
    if (policyMaxBudgetUsd > 0)
      return Math.min(profile.maxBudgetUsd, policyMaxBudgetUsd, platformMaxScanBudgetUsd)
  }
  return Math.min(profile.maxBudgetUsd, platformMaxScanBudgetUsd)
}
