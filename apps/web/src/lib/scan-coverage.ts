export const SCANNER_COVERAGE_EVENT_MESSAGE = "Deterministic scanner coverage incomplete"

export interface ScanCoverageEvent {
  stage: string
  level: string
  message: string
  metadata?: Record<string, unknown> | null
}

export interface ScannerCoverageWarning {
  scanner: string
  status: string
  subject?: string
  reason: string
}

function readString(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Extract only the structured, deterministic coverage warnings emitted by the
 * worker. Generic scanner warnings deliberately remain in the event history.
 */
export function getScannerCoverageWarnings(events: ScanCoverageEvent[]): ScannerCoverageWarning[] {
  return events.flatMap((event) => {
    if (
      event.stage !== "scanner" ||
      event.level !== "warning" ||
      event.message !== SCANNER_COVERAGE_EVENT_MESSAGE
    ) {
      return []
    }

    const scanner = readString(event.metadata, "scanner")
    const status = readString(event.metadata, "status")
    const reason = readString(event.metadata, "reason")
    if (!scanner || !status || !reason) return []

    const subject = readString(event.metadata, "subject")
    return [{ scanner, status, reason, ...(subject ? { subject } : {}) }]
  })
}
