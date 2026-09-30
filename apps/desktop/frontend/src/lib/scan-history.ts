import type { ScanSummary } from "./types"

export function appendScanHistory(current: ScanSummary[], next: ScanSummary[]): ScanSummary[] {
  const knownIds = new Set(current.map((scan) => scan.scanId))
  return [
    ...current,
    ...next.filter((scan) => {
      if (knownIds.has(scan.scanId)) return false
      knownIds.add(scan.scanId)
      return true
    }),
  ]
}
