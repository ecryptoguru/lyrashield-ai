// Public gate input and output shapes. Kept independent of the evaluator so
// checksum helpers can consume the types without importing the evaluator.
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
  /** Canonical mode — decides mode-conditional coverage (e.g. engine on URL). */
  mode?: string | null
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
