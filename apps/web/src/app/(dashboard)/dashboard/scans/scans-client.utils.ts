export function mergePolledScans<T extends { id: string }>(current: T[], refreshed: T[]): T[] {
  const refreshedIds = new Set(refreshed.map((scan) => scan.id))
  return [...refreshed, ...current.filter((scan) => !refreshedIds.has(scan.id))]
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
