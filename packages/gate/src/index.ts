/**
 * @lyrashield/gate — the LyraShield Launch Gate.
 *
 * A named, versioned readiness standard and the pure function that evaluates
 * stored evidence into a launch verdict. This package follows the same rule as
 * @lyrashield/score: the math is pure and versioned; the database layer owns
 * persistence and never the verdict logic.
 *
 * Standard: lyrashield-gate/2.0.0.
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

export const GATE_STANDARD_VERSION = "lyrashield-gate/2.0.0"

export {
  GATE_ASSESSMENT_VERSION,
  GATE_FRESHNESS_MS,
  evaluateGateApplicability,
  type GateApplicabilityInput,
  type GateApplicabilityReason,
  type GateApplicabilityResult,
  type GateAssessmentIdentity,
  type GateAssessmentSnapshot,
} from "./applicability"

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
  /** A receipt scoped to this assessment establishes VALIDATED or VERIFIED. */
  hasPositiveEvidence?: boolean
  /** A current, policy-allowed accepted-risk or false-positive disposition. */
  hasApplicableDisposition?: boolean
  /** The human disposition counted in the assessment disclosure. */
  applicableDisposition?: "ACCEPTED_RISK" | "FALSE_POSITIVE" | null
  /** DUPLICATE findings inherit the canonical finding's unresolved state. */
  duplicateCanonicalResolved?: boolean
  /** lastSeenAt as epoch ms — drives staleness. */
  lastSeenAtMs: number
}

export type GateCoverageStatus =
  "COMPLETED" | "PARTIAL" | "NOT_APPLICABLE" | "BLOCKED" | "TIMED_OUT" | "FAILED"
export type GateNonCoverageStatus = GateCoverageStatus | "MISSING" | "NOT_RUN"

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
  /**
   * Whether the target type is covered by the standard at all. False means the
   * registry has no coverage requirements for this type yet (deferred type),
   * so no verdict beyond INSUFFICIENT_EVIDENCE can be honestly issued — even
   * with completed receipts. The pure function enforces this itself rather
   * than trusting the caller to pass an empty requiredScanners list, because
   * empty-list-means-covered is indistinguishable from
   * empty-list-means-deferred at the call site.
   */
  targetTypeCovered: boolean
  /** A policy fingerprint makes policy changes invalidate later applicability. */
  policyFingerprint?: string | null
  /** A supported manifest and source identity bind this assessment to a release. */
  assessmentIdentityComplete?: boolean
}

// ─── Output types ────────────────────────────────────────────────────────────

export type GateVerdictState = "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"

export interface NonCoverageItem {
  controlId: string
  scanner: string
  status: GateNonCoverageStatus
  reason: string | null
  reasonCode: string
  recoveryAction: string
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
  insufficientPositiveEvidence: number
  /** Blocking findings still resting on bare DETECTED — the weak spot. */
  blockingUnverified: number
  /**
   * Unresolved findings by severity. MEDIUM/LOW are counted for disclosure
   * but do not block launch in v1.0.0. Legacy verdicts lack those counts and
   * the public report must represent that absence as not evaluated.
   */
  unresolvedCritical: number
  unresolvedHigh: number
  unresolvedMedium: number
  unresolvedLow: number
  acceptedRisk: number
  falsePositive: number
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
  if (f.retestConfirmedResolved || f.hasApplicableDisposition) return false
  if (f.status === "DUPLICATE") return !f.duplicateCanonicalResolved
  // Historical direct FIXED values and unbound human dispositions are visible
  // history, not a v2 resolution. They need a trusted retest or an applicable
  // disposition bound to this assessment before they can stop enforcement.
  if (f.status === "FIXED" || f.status === "ACCEPTED_RISK" || f.status === "FALSE_POSITIVE") {
    return true
  }
  return BLOCKING_STATUSES.has(f.status)
}

function summarizeEvidence(findings: GateFindingInput[]): EvidenceSummary {
  const summary: EvidenceSummary = {
    detected: 0,
    validated: 0,
    verified: 0,
    retestConfirmed: 0,
    inconclusive: 0,
    insufficientPositiveEvidence: 0,
    blockingUnverified: 0,
    unresolvedCritical: 0,
    unresolvedHigh: 0,
    unresolvedMedium: 0,
    unresolvedLow: 0,
    acceptedRisk: 0,
    falsePositive: 0,
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
    if (f.hasApplicableDisposition && f.applicableDisposition === "ACCEPTED_RISK") {
      summary.acceptedRisk++
    }
    if (f.hasApplicableDisposition && f.applicableDisposition === "FALSE_POSITIVE") {
      summary.falsePositive++
    }
    if (isBlocking(f) && !f.hasPositiveEvidence) summary.insufficientPositiveEvidence++
    if (isBlocking(f) && f.verificationStatus === "DETECTED") summary.blockingUnverified++
    if (isBlocking(f) && f.severity === "CRITICAL") summary.unresolvedCritical++
    if (isBlocking(f) && f.severity === "HIGH") summary.unresolvedHigh++
    if (isBlocking(f) && f.severity === "MEDIUM") summary.unresolvedMedium++
    if (isBlocking(f) && f.severity === "LOW") summary.unresolvedLow++
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
  let coverageStatement: string[] = []
  const assessmentIdentityIncomplete = input.assessmentIdentityComplete === false
  if (assessmentIdentityIncomplete) {
    nonCoverage.push({
      controlId: "assessment-identity",
      scanner: "assessment-identity",
      status: "NOT_RUN",
      reason: "The completed assessment lacks a supported immutable manifest and release identity.",
      reasonCode: "ASSESSMENT_IDENTITY_INCOMPLETE",
      recoveryAction: "Run a new assessment with a complete immutable result manifest.",
    })
  }

  // GATE-0 — Target-type coverage (the registry gate). A target type the
  // standard does not yet cover (deferred: no registry requirements exist)
  // can never earn READY/NOT_READY, no matter what receipts exist — claiming
  // otherwise would present an unexamined dimension as examined. This is
  // enforced HERE rather than by callers passing an empty requiredScanners,
  // because an empty required list is ambiguous between "covered with no
  // requirements" and "deferred".
  if (!input.targetTypeCovered) {
    const evidence = summarizeEvidence(input.findings)
    return {
      standardVersion: GATE_STANDARD_VERSION,
      state: "INSUFFICIENT_EVIDENCE",
      nonCoverage: [
        {
          controlId: "target-type",
          scanner: "target-type",
          status: "NOT_RUN",
          reason: "This target type is not covered by the readiness standard yet.",
          reasonCode: "UNSUPPORTED_TARGET_TYPE",
          recoveryAction: "Use a target type covered by this standard or extend the standard.",
        },
      ],
      coverageStatement: [],
      blockingReasons: [],
      evidenceSummary: evidence,
      staleness: {
        current: false,
        reason: "This target type is not covered by the readiness standard yet.",
      },
    }
  }

  // GATE-1 — Coverage sufficiency (the honesty gate).
  let anyCompleted = false
  const receiptsByScanner = new Map<string, GateCoverageReceiptInput[]>()
  for (const r of receipts) {
    const grouped = receiptsByScanner.get(r.scanner) ?? []
    grouped.push(r)
    receiptsByScanner.set(r.scanner, grouped)
    if (r.status === "COMPLETED") {
      anyCompleted = true
      if (!coverageStatement.includes(r.scanner)) coverageStatement.push(r.scanner)
    } else if (r.status !== "NOT_APPLICABLE") {
      nonCoverage.push({
        controlId: r.controlId,
        scanner: r.scanner,
        status: r.status,
        reason: r.reason ?? null,
        reasonCode: "CONTROL_INCOMPLETE",
        recoveryAction: "Resolve the control failure and run a new assessment.",
      })
    } else {
      // NOT_APPLICABLE counts as evaluated-but-out-of-scope; disclosed, not failed.
      coverageStatement.push(`${r.scanner} (not applicable)`)
    }
  }

  const missingRequired = input.requiredScanners.filter((scanner) => {
    const scannerReceipts = receiptsByScanner.get(scanner)
    if (!scannerReceipts?.length) {
      nonCoverage.push({
        controlId: scanner,
        scanner,
        status: "MISSING",
        reason: "The required control produced no coverage receipt.",
        reasonCode: "REQUIRED_CONTROL_MISSING",
        recoveryAction: "Run an assessment that completes this required control.",
      })
      return true
    }
    return scannerReceipts.some(
      (receipt) => receipt.status !== "COMPLETED" && receipt.status !== "NOT_APPLICABLE"
    )
  })
  coverageStatement = coverageStatement.filter((scanner) => !missingRequired.includes(scanner))

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
  if (!anyCompleted || missingRequired.length > 0 || assessmentIdentityIncomplete) {
    return {
      standardVersion: GATE_STANDARD_VERSION,
      state: "INSUFFICIENT_EVIDENCE",
      nonCoverage,
      coverageStatement,
      blockingReasons,
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

  // GATE-4 — A non-blocking severity remains nonblocking, but READY is still a
  // positive claim. Every unresolved MEDIUM/LOW finding therefore needs a
  // scoped positive receipt or an applicable recorded disposition.
  const unresolvedWithoutEvidence = input.findings.some(
    (finding) =>
      isBlocking(finding) && !finding.hasPositiveEvidence && !finding.hasApplicableDisposition
  )

  if (unresolvedWithoutEvidence) {
    return {
      standardVersion: GATE_STANDARD_VERSION,
      state: "INSUFFICIENT_EVIDENCE",
      nonCoverage,
      coverageStatement,
      blockingReasons,
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
