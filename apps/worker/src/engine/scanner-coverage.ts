export type ScannerCoverageStatus = "partial" | "unsupported" | "bounded"

export interface ScannerCoverageIssue {
  scanner:
    "engine" | "agent_config" | "sca" | "secrets" | "url" | "ai_app_security" | "ml_supply_chain"
  status: ScannerCoverageStatus
  subject?: string
  reason: string
}

export function recordCoverageIssue(
  issues: ScannerCoverageIssue[] | undefined,
  issue: ScannerCoverageIssue
): void {
  if (!issues?.some((existing) => JSON.stringify(existing) === JSON.stringify(issue))) {
    issues?.push(issue)
  }
}
