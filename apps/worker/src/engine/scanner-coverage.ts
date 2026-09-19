import type {
  EngineCoverageGap,
  ScopedCoverageEntry,
  ScopedCoverageOutcome,
} from "./output-parser"

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

// ── run.json 1.1 scoped coverage ────────────────────────────────────────────
// coverage.json entries and gaps are MODEL-DECLARED records of what the
// engine's agents say they looked at. They persist as receipt rows under
// namespaced controlIds so they can never be confused with numeric vibe
// control ids or deterministic scanner family names, and they never mark a
// deterministic control outcome.

/**
 * Receipt controlId prefixes for engine-declared scoped coverage. The colon
 * namespacing guarantees no collision with `vibe-NN` control ids or family
 * names — deterministic consumers filter on these prefixes.
 */
export const ENGINE_SCOPE_RECEIPT_PREFIX = "engine-scope:"
export const ENGINE_GAP_RECEIPT_PREFIX = "engine-gap:"

/** True for namespaced engine-declared coverage receipts, never for control ids. */
export function isEngineDeclaredCoverageId(controlId: string): boolean {
  return (
    controlId.startsWith(ENGINE_SCOPE_RECEIPT_PREFIX) ||
    controlId.startsWith(ENGINE_GAP_RECEIPT_PREFIX)
  )
}

/**
 * Declared outcome → receipt status. "needs_follow_up" and runtime-declared
 * gaps stay PARTIAL — unselected, blocked, or truncated work is never
 * presented as assessed. Completed declared investigations map to COMPLETED
 * but always carry `declaredBy: "engine_model"` metadata so a reader can tell
 * a self-report from a deterministic outcome.
 */
export const SCOPED_COVERAGE_STATUS: Record<
  ScopedCoverageOutcome,
  "COMPLETED" | "NOT_APPLICABLE" | "PARTIAL"
> = {
  reported: "COMPLETED",
  no_issue_found: "COMPLETED",
  ruled_out: "COMPLETED",
  not_applicable: "NOT_APPLICABLE",
  needs_follow_up: "PARTIAL",
}

export interface ScopedCoverageReceiptRow {
  scanner: "engine"
  controlId: string
  status: "COMPLETED" | "NOT_APPLICABLE" | "PARTIAL"
  reason?: string
  subject?: string
  metadata: Record<string, unknown>
}

/** Map parsed coverage.json content into namespaced receipt rows. */
export function scopedCoverageReceipts(
  entries: ScopedCoverageEntry[],
  gaps: EngineCoverageGap[]
): ScopedCoverageReceiptRow[] {
  const rows: ScopedCoverageReceiptRow[] = []
  for (const entry of entries) {
    rows.push({
      scanner: "engine",
      controlId: `${ENGINE_SCOPE_RECEIPT_PREFIX}${entry.id}`,
      status: SCOPED_COVERAGE_STATUS[entry.outcome],
      ...(entry.reason ? { reason: entry.reason } : {}),
      subject: entry.subject,
      metadata: {
        declaredBy: "engine_model",
        outcome: entry.outcome,
        evidenceRefs: entry.evidenceRefs ?? [],
        ...(entry.recordedBy ? { recordedBy: entry.recordedBy } : {}),
        ...(entry.recordedAt ? { recordedAt: entry.recordedAt } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.previousOutcomes?.length
          ? { previousOutcomes: entry.previousOutcomes }
          : {}),
      },
    })
  }
  for (const [index, gap] of gaps.entries()) {
    rows.push({
      scanner: "engine",
      controlId: `${ENGINE_GAP_RECEIPT_PREFIX}${index}:${gap.kind}`,
      status: "PARTIAL",
      reason: gap.detail,
      ...(gap.subject ? { subject: gap.subject } : {}),
      metadata: {
        declaredBy: "engine_runtime",
        kind: gap.kind,
      },
    })
  }
  return rows
}
