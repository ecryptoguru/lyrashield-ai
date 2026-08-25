import { isActiveScan } from "@/lib/scan-presentation"

export function mergePolledScans<T extends { id: string; status: string }>(
  current: T[],
  refreshed: T[],
  { hasMore }: { hasMore: boolean }
): T[] {
  const refreshedIds = new Set(refreshed.map((scan) => scan.id))
  return [
    ...refreshed,
    ...current.filter(
      (scan) => !refreshedIds.has(scan.id) && (hasMore || !isActiveScan(scan.status))
    ),
  ]
}

export function missingActiveScanIds<T extends { id: string; status: string }>(
  current: T[],
  firstPageIds: ReadonlySet<string>,
  firstPageHasMore: boolean
): string[] {
  if (!firstPageHasMore) return []
  return current
    .filter((scan) => isActiveScan(scan.status) && !firstPageIds.has(scan.id))
    .map((scan) => scan.id)
}

export function mergeResolvedOffPageScans<T extends { id: string }>(
  current: T[],
  resolved: T[],
  requestedIds: string[]
): T[] {
  const resolvedById = new Map(resolved.map((scan) => [scan.id, scan] as const))
  const requested = new Set(requestedIds)
  return current
    .filter((scan) => !requested.has(scan.id) || resolvedById.has(scan.id))
    .map((scan) => resolvedById.get(scan.id) ?? scan)
}

export function scanRecoveryHref(scan: { targetId: string; goal: string; mode: string }): string {
  const params = new URLSearchParams({
    new: "1",
    target: scan.targetId,
    goal: scan.goal,
    mode: scan.mode,
  })
  return `/dashboard/scans?${params.toString()}`
}

export function findRecoveryPreset<
  T extends { id: string; available: boolean; goal: string; mode: string },
>(options: T[], goal?: string, mode?: string): string {
  return (
    options.find((option) => option.available && option.goal === goal && option.mode === mode)
      ?.id ?? ""
  )
}

export function isBillingRecoveryCode(code: string | null): boolean {
  return (
    code !== null && ["NO_MINUTES_REMAINING", "TRIAL_EXPIRED", "DEEP_NOT_ALLOWED"].includes(code)
  )
}

export function getReviewSetupGuidance({
  targetId,
  targetType,
  hasApiSpec,
}: {
  targetId: string
  targetType: string
  hasApiSpec: boolean
}) {
  if (targetType !== "API" || hasApiSpec) return null

  return {
    actionLabel: "Add OpenAPI document",
    href: `/dashboard/targets/${targetId}`,
    message: "Add an OpenAPI document to unlock Contract and Contract Behavior reviews.",
  }
}
