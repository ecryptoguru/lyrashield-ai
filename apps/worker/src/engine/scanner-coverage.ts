type ScannerCoverageStatus = "partial" | "unsupported" | "bounded"

/**
 * Standardized per-scanner discovery receipt — what the scanner actually
 * enumerated versus skipped, with the reasons. Renders on the scan's coverage
 * receipts so a small scan is provably small, not silently thin.
 */
interface ScannerDiscoveryReceipt {
  filesScanned: number
  bytesScanned: number
  skippedByReason: Record<string, number>
  representativeSkippedPaths?: string[]
}

/** Mutable sink a scanner fills during its run — same out-param pattern as coverageIssues. */
export type ScannerDiscovery = Record<string, ScannerDiscoveryReceipt>

export interface ScannerCoverageIssue {
  scanner:
    | "engine"
    | "agent_config"
    | "sca"
    | "secrets"
    | "url"
    | "ai_app_security"
    | "ml_supply_chain"
    | "sast"
    | "iac"
  status: ScannerCoverageStatus
  subject?: string
  reason: string
  metadata?: Record<string, unknown>
}

export function recordCoverageIssue(
  issues: ScannerCoverageIssue[] | undefined,
  issue: ScannerCoverageIssue
): void {
  if (!issues?.some((existing) => JSON.stringify(existing) === JSON.stringify(issue))) {
    issues?.push(issue)
  }
}
