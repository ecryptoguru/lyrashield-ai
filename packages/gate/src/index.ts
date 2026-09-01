/**
 * @lyrashield/gate — the LyraShield Launch Gate.
 *
 * A named, versioned readiness standard and the pure function that evaluates
 * stored evidence into a launch verdict. This package follows the same rule as
 * @lyrashield/score: the math is pure and versioned; the database layer owns
 * persistence and never the verdict logic.
 *
 * Standard: lyrashield-gate/1.0.0 (see STANDARD.md / the WP2 proposal).
 *
 * Verdict states:
 * - READY — every check passes against current evidence.
 * - NOT_READY — at least one blocking check fails; blockingReasons say what.
 * - INSUFFICIENT_EVIDENCE — coverage too thin to judge. Not a cop-out: it is the
 *   honest answer when we could not look, and it is what makes READY/NOT_READY
 *   believable.
 *
 * Founder-confirmed scope (2026-09-02): every check automated, no manual steps,
 * thresholds versioned here (no per-run approval). v1.0.0 does NOT block on
 * MEDIUM/LOW findings (they feed the score and report, not the gate). Scanner
 * coverage classes are derived from the scan coverage registry rather than a
 * hand-maintained list, so the standard cannot drift from the scanners that
 * actually run.
 */

export const GATE_STANDARD_VERSION = "lyrashield-gate/1.0.0"

// ─── Input types (evidence in; no Prisma imports — the DB layer adapts) ──────

export type GateFindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"

/** Finding lifecycle statuses that count as unresolved for the gate. */
export type GateBlockingStatus =
  "OPEN" | "FIX_READY" | "PR_OPENED" | "TICKET_CREATED" | "FIXED_PENDING_RETEST"

export type GateVerificationStatus =
  "DETECTED" | "VALIDATED" | "VERIFIED" | "BLOCKED" | "INCONCLUSIVE"

export interface GateFindingInput {
  id: string
  severity: GateFindingSeverity
  /** Finding lifecycle status; only blocking statuses can block. */
  status: string
  verificationStatus: GateVerificationStatus
  /** Retest-confirmed resolution (verificationMethod RETEST + resolved). */
  retestConfirmedResolved: boolean
  /** lastSeenAt as epoch ms — drives staleness. */
  lastSeenAtMs: number
}

export type GateCoverageStatus =
  "COMPLETED" | "PARTIAL" | "NOT_APPLICABLE" | "BLOCKED" | "TIMED_OUT" | "FAILED"

export interface GateCoverageReceiptInput {
  /** Scanner family / control id (e.g. "engine", "sca", "secrets", "url"). */
  controlId: string
  scanner: string
  status: GateCoverageStatus
  reason?: string | null
}

export interface GateScanInput {
  id: string
  /** endedAt as epoch ms — the freshness anchor for this scan. */
  endedAtMs: number | null
  status: string
}

export interface GateEvidenceInput {
  targetId: string
  /** Latest completed scan for the target (null if none). */
  latestCompletedScan: GateScanInput | null
  /** Coverage receipts belonging to the latest completed scan. */
  coverageReceipts: GateCoverageReceiptInput[]
  /** Non-deleted findings for the target. */
  findings: GateFindingInput[]
  /** Scanner classes that MUST report for this target type (registry-derived). */
  requiredScanners: readonly string[]
}

// ─── Output types ────────────────────────────────────────────────────────────

export type GateVerdictState = "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"

export interface NonCoverageItem {
  controlId: string
  scanner: string
  status: GateCoverageStatus
  reason: string | null
}

export interface BlockingReason {
  findingId: string
  severity: GateFindingSeverity
  verificationStatus: GateVerificationStatus
}

export interface EvidenceSummary {
  detected: number
  validated: number
  verified: number
  retestConfirmed: number
  inconclusive: number
  /** Blocking findings still resting on bare DETECTED — the weak spot. */
  blockingUnverified: number
}

export interface StalenessSignal {
  current: boolean
  /** Present when current=false: why the verdict is stale. */
  reason: string | null
}

export interface GateVerdictResult {
  standardVersion: string
  state: GateVerdictState
  /** Always present; empty array only when coverage is genuinely complete. */
  nonCoverage: NonCoverageItem[]
  /** Positive claim: scanner classes that WERE evaluated (COMPLETED). */
  coverageStatement: string[]
  blockingReasons: BlockingReason[]
  evidenceSummary: EvidenceSummary
  staleness: StalenessSignal
}

// ─── The standard ────────────────────────────────────────────────────────────

const BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "TICKET_CREATED",
  "FIXED_PENDING_RETEST",
])

function isBlocking(f: GateFindingInput): boolean {
  // A retest-confirmed-resolved finding is no longer blocking even if its
  // lifecycle status has not yet flipped (the retest closed the loop).
  return BLOCKING_STATUSES.has(f.status) && !f.retestConfirmedResolved
}

function summarizeEvidence(findings: GateFindingInput[]): EvidenceSummary {
  const summary: EvidenceSummary = {
    detected: 0,
    validated: 0,
    verified: 0,
    retestConfirmed: 0,
    inconclusive: 0,
    blockingUnverified: 0,
  }
  for (const f of findings) {
    switch (f.verificationStatus) {
      case "DETECTED":
        summary.detected++
        break
      case "VALIDATED":
        summary.validated++
        break
      case "VERIFIED":
        summary.verified++
        break
      case "INCONCLUSIVE":
        summary.inconclusive++
        break
      case "BLOCKED":
        break
    }
    if (f.retestConfirmedResolved) summary.retestConfirmed++
    if (isBlocking(f) && f.verificationStatus === "DETECTED") summary.blockingUnverified++
  }
  return summary
}

function evaluateStaleness(input: GateEvidenceInput): StalenessSignal {
  const latest = input.latestCompletedScan
  if (!latest || latest.endedAtMs === null) {
    return { current: false, reason: "No completed scan to anchor freshness." }
  }
  const newestFindingMs = input.findings.reduce((max, f) => Math.max(max, f.lastSeenAtMs), 0)
  if (newestFindingMs > latest.endedAtMs) {
    return {
      current: false,
      reason:
        "A finding was observed after the latest completed scan — re-run the gate on current code.",
    }
  }
  return { current: true, reason: null }
}

/**
 * Evaluate the standard against stored evidence. Pure and deterministic: the
 * same input always yields the same output. No clocks, no I/O, no randomness.
 */
export function computeGateVerdict(input: GateEvidenceInput): GateVerdictResult {
  const receipts = input.coverageReceipts
  const nonCoverage: NonCoverageItem[] = []
  const coverageStatement: string[] = []

  // GATE-1 — Coverage sufficiency (the honesty gate).
  let anyCompleted = false
  const receiptByScanner = new Map<string, GateCoverageReceiptInput>()
  for (const r of receipts) {
    receiptByScanner.set(r.scanner, r)
    if (r.status === "COMPLETED") {
      anyCompleted = true
      coverageStatement.push(r.scanner)
    } else if (r.status !== "NOT_APPLICABLE") {
      nonCoverage.push({
        controlId: r.controlId,
        scanner: r.scanner,
        status: r.status,
        reason: r.reason ?? null,
      })
    } else {
      // NOT_APPLICABLE counts as evaluated-but-out-of-scope; disclosed, not failed.
      coverageStatement.push(`${r.scanner} (not applicable)`)
    }
  }

  const missingRequired = input.requiredScanners.filter((scanner) => {
    const receipt = receiptByScanner.get(scanner)
    return !receipt || (receipt.status !== "COMPLETED" && receipt.status !== "NOT_APPLICABLE")
  })

  // GATE-2 / GATE-3 — only CRITICAL and HIGH blockers fail the gate. MEDIUM/LOW
  // with a blocking lifecycle status are surfaced in evidenceSummary but do NOT
  // block in v1.0.0 (founder-confirmed 2026-09-02).
  const blocking = input.findings.filter(
    (f) => isBlocking(f) && (f.severity === "CRITICAL" || f.severity === "HIGH")
  )
  const blockingReasons: BlockingReason[] = blocking
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .map((f) => ({
      findingId: f.id,
      severity: f.severity,
      verificationStatus: f.verificationStatus,
    }))

  const evidenceSummary = summarizeEvidence(input.findings)
  const staleness = evaluateStaleness(input)

  // Resolution order: GATE-1 -> GATE-2/3 -> GATE-4 -> READY. GATE-5 annotates.
  if (!anyCompleted || missingRequired.length > 0) {
    return {
      standardVersion: GATE_STANDARD_VERSION,
      state: "INSUFFICIENT_EVIDENCE",
      nonCoverage,
      coverageStatement,
      blockingReasons: [],
      evidenceSummary,
      staleness,
    }
  }

  // GATE-2 / GATE-3 — unresolved CRITICAL / HIGH blockers.
  if (blockingReasons.length > 0) {
    return {
      standardVersion: GATE_STANDARD_VERSION,
      state: "NOT_READY",
      nonCoverage,
      coverageStatement,
      blockingReasons,
      evidenceSummary,
      staleness,
    }
  }

  // GATE-4 — Evidence-state floor: READY may not rest on DETECTED-only findings.
  const openMediumPlus = input.findings.filter(
    (f) =>
      BLOCKING_STATUSES.has(f.status) &&
      !f.retestConfirmedResolved &&
      (f.severity === "MEDIUM" || f.severity === "LOW")
  )
  const anyVerifiedOrRetest = evidenceSummary.verified + evidenceSummary.retestConfirmed > 0
  const allDetectedOnly =
    input.findings.length > 0 &&
    input.findings.every((f) => f.verificationStatus === "DETECTED") &&
    !anyVerifiedOrRetest

  if (allDetectedOnly && (input.findings.length > 0 || openMediumPlus.length > 0)) {
    return {
      standardVersion: GATE_STANDARD_VERSION,
      state: "INSUFFICIENT_EVIDENCE",
      nonCoverage,
      coverageStatement,
      blockingReasons: [],
      evidenceSummary,
      staleness,
    }
  }

  return {
    standardVersion: GATE_STANDARD_VERSION,
    state: "READY",
    nonCoverage,
    coverageStatement,
    blockingReasons: [],
    evidenceSummary,
    staleness,
  }
}

function severityRank(severity: GateFindingSeverity): number {
  switch (severity) {
    case "CRITICAL":
      return 5
    case "HIGH":
      return 4
    case "MEDIUM":
      return 3
    case "LOW":
      return 2
    case "INFO":
      return 1
  }
}

export {
  SCANNER_FAMILIES,
  isTargetTypeCovered,
  requiredScannersForTarget,
  type GateTargetType,
  type ScannerFamily,
} from "./coverage-matrix"
export { computeInputChecksum, computeVerdictChecksum } from "./checksum"
