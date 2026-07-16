export function mergePolledScans<T extends { id: string }>(current: T[], refreshed: T[]): T[] {
  const refreshedIds = new Set(refreshed.map((scan) => scan.id))
  return [...refreshed, ...current.filter((scan) => !refreshedIds.has(scan.id))]
}
