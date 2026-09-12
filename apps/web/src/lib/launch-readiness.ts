import type { FindingSeverity, FindingStatus } from "@lyrashield/types"

export interface FindingForReadiness {
  id: string
  severity: FindingSeverity
  status: FindingStatus
  verified: boolean
  confidence: string
  category?: string | null
  cwe?: string | null
  title: string
  summary: string
}

export type ReadinessVerdict =
  "NOT_EVALUATED" | "INCONCLUSIVE" | "GO" | "GO_WITH_CONDITIONS" | "NO_GO"

/**
 * Whether a completed scan actually managed to evaluate the target.
 *
 * A scan can finish successfully having checked nothing — the URL scanner is
 * blocked, the engine is skipped for the target type, SCA/secrets have no source
 * checkout. Zero findings then means "we could not look", which is the opposite
 * of "we looked and it was clean". Without this distinction the readiness report
 * scores such a run 100/100 and returns GO, which is a false all-clear on the
 * one screen a customer forwards to their team.
 */
export interface ReadinessCoverage {
  /** True when at least one scanner successfully evaluated the target. */
  evaluated: boolean
  /** Operator-facing explanation shown when `evaluated` is false. */
  reason?: string
  /**
   * Applicable controls that did not complete (BLOCKED / TIMED_OUT / FAILED /
   * PARTIAL receipts). NOT_APPLICABLE receipts are excluded by the caller: a
   * scanner that does not apply to the target says nothing about coverage.
   *
   * `evaluated` is binary, so a run where one scanner completed and eleven were
   * blocked reads identically to a fully covered run and scores 100/100 GO. That
   * is the same false all-clear `evaluated` exists to prevent, one level up: we
   * did look, but not at most of it. A partial assessment therefore never issues
   * a numeric score or an unconditional GO.
   */
  unresolvedControls?: number
}

export interface LaunchReadinessReport {
  /** Canonical Gate v2 state. Legacy helpers omit this compatibility field. */
  state?: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  verdict: ReadinessVerdict
  score: number | null
  summary: string
  blockingFindings: number
  totalFindings: number
  verifiedFindings: number
  bySeverity: Record<string, number>
  conditions: string[]
  recommendations: string[]
}

export type CanonicalLaunchReadinessReport = Omit<LaunchReadinessReport, "score"> & {
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  score: null
  triageScore: number | null
}

export interface GateReadinessTarget {
  targetId: string
  targetName: string
  /** Effective state after applicability rules — what the gate would enforce. */
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  /** The immutable verdict state before applicability rules (absent/null: no verdict). */
  historicalState?: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE" | null
  applicable: boolean
  blockingFindings: number
  reasons: { code: string; message: string }[]
  /**
   * The release identity the verdict covers (the assessment's own identity
   * when the caller enforces none). Absent when there is no assessment to
   * describe. Rendered so a verdict reads "ready for commit abc1234" rather
   * than an unexplained all-clear.
   *
   * NOTE: this is the gate's evaluatedIdentity — when a release check is
   * requested and it mismatches, the gate returns the REQUESTED value here.
   * Always read `assessedIdentity` for "which release was actually assessed".
   */
  identity?: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
  /**
   * The identity retained in the assessment snapshot itself — the only
   * trustworthy answer to "which release does this assessment describe".
   * Independent of any requested identity.
   */
  assessedIdentity?: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
}

export interface FindingReadinessAggregate {
  severity: FindingSeverity
  status: FindingStatus
  verified: boolean
  count: number
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  CRITICAL: 100,
  HIGH: 50,
  MEDIUM: 20,
  LOW: 5,
  INFO: 0,
}

const BLOCKING_STATUSES = new Set<string>([
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "TICKET_CREATED",
  "FIXED_PENDING_RETEST",
])

/**
 * Coverage-receipt statuses that mean a scanner applied to the target but did
 * not finish. NOT_APPLICABLE is deliberately absent (it says nothing about
 * coverage) and so is COMPLETED. Shared so every readiness caller counts the
 * same thing; mirrors APPLICABLE_RECEIPT_STATUSES in dashboard-overview.
 */
export const INCOMPLETE_APPLICABLE_RECEIPT_STATUSES = [
  "PARTIAL",
  "BLOCKED",
  "TIMED_OUT",
  "FAILED",
] as const

export function generateLaunchReadinessReport(
  findings: FindingForReadiness[],
  hasCompletedScan: boolean,
  coverage?: ReadinessCoverage
): LaunchReadinessReport {
  const grouped = new Map<string, FindingReadinessAggregate>()
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.status}:${finding.verified}`
    const current = grouped.get(key)
    if (current) current.count++
    else
      grouped.set(key, {
        severity: finding.severity,
        status: finding.status,
        verified: finding.verified,
        count: 1,
      })
  }
  const aggregates = [...grouped.values()]
  return generateLaunchReadinessReportFromAggregate(aggregates, hasCompletedScan, coverage)
}

export function generateLaunchReadinessReportFromAggregate(
  groups: FindingReadinessAggregate[],
  hasCompletedScan: boolean,
  coverage?: ReadinessCoverage
): LaunchReadinessReport {
  const total = groups.reduce((sum, group) => sum + group.count, 0)
  const verified = groups.reduce((sum, group) => sum + (group.verified ? group.count : 0), 0)

  if (!hasCompletedScan) {
    return {
      verdict: "NOT_EVALUATED",
      score: null,
      summary:
        "No completed scan evidence is available. Run a scan before making a launch decision.",
      blockingFindings: 0,
      totalFindings: total,
      verifiedFindings: verified,
      bySeverity: {},
      conditions: ["Complete at least one security scan before launch"],
      recommendations: [],
    }
  }

  // A scan that completed without evaluating anything must never present as a
  // clean result. Absence of evidence is reported as absence of evidence, with
  // no numeric score to misread and no GO verdict to act on.
  if (coverage && !coverage.evaluated) {
    const why = coverage.reason ?? "No scanner was able to inspect the target."
    const summary = `The scan completed but could not evaluate this target, so no findings could be produced. This is not a clean result. ${why}`
    const condition = "Resolve the coverage failure and re-run before treating this as assessed"
    return {
      verdict: "INCONCLUSIVE",
      score: null,
      summary,
      blockingFindings: 0,
      totalFindings: total,
      verifiedFindings: verified,
      bySeverity: {},
      conditions: [condition],
      recommendations: coverage.reason ? [coverage.reason] : [],
    }
  }

  const bySeverity: Record<string, number> = {}
  let blockingFindings = 0
  let score = 100

  for (const group of groups) {
    bySeverity[group.severity] = (bySeverity[group.severity] ?? 0) + group.count

    if (BLOCKING_STATUSES.has(group.status)) {
      const weight = SEVERITY_WEIGHTS[group.severity] ?? 0
      score -= weight * group.count
      if (group.severity === "CRITICAL" || group.severity === "HIGH") {
        blockingFindings += group.count
      }
    }
  }

  score = Math.max(0, Math.min(100, score))

  let verdict: ReadinessVerdict
  const conditions: string[] = []
  const recommendations: string[] = []

  if (blockingFindings > 0) {
    verdict = "NO_GO"
    conditions.push(
      `${blockingFindings} unresolved critical/high finding(s) must be fixed before launch`
    )
  } else if (score >= 80) {
    verdict = "GO"
  } else if (score >= 40) {
    verdict = "GO_WITH_CONDITIONS"
    conditions.push("Address remaining medium-severity findings before production deployment")
  } else {
    verdict = "NO_GO"
    conditions.push("Security score too low for production launch")
  }

  // A partial assessment must not present as a clean one. Findings we did see
  // still stand (NO_GO keeps its verdict and score), but an otherwise-clean
  // sheet cannot certify a launch while applicable controls are unestablished.
  const unresolvedControls = coverage?.unresolvedControls ?? 0
  let scopeLimited = false
  if (unresolvedControls > 0) {
    conditions.push(
      `${unresolvedControls} applicable control(s) could not be established — resolve them before treating this as a full assessment`
    )
    if (verdict === "GO") {
      verdict = "GO_WITH_CONDITIONS"
      scopeLimited = true
    }
  }

  if (total > 0 && verified === 0) {
    recommendations.push(
      "No findings have been verified — run a deeper scan to confirm vulnerabilities"
    )
  }

  if ((bySeverity.CRITICAL ?? 0) > 0) {
    recommendations.push(`${bySeverity.CRITICAL} critical finding(s) require immediate attention`)
  }

  if ((bySeverity.HIGH ?? 0) > 0) {
    recommendations.push(
      `${bySeverity.HIGH} high-severity finding(s) should be prioritized for remediation`
    )
  }

  const summary = scopeLimited
    ? `${total} finding(s) detected, ${verified} verified. ${unresolvedControls} applicable control(s) could not be established, so this assessment is scope-limited and no security score is issued. Verdict: ${verdict}.`
    : `${total} finding(s) detected, ${verified} verified. Security score: ${score}/100. Verdict: ${verdict}.`

  return {
    verdict,
    score: scopeLimited ? null : score,
    summary,
    blockingFindings,
    totalFindings: total,
    verifiedFindings: verified,
    bySeverity,
    conditions,
    recommendations,
  }
}

/**
 * Plain-language sentence for a gate applicability reason. The canonical reason
 * codes live in @lyrashield/gate; their `message` fields are internal phrasing
 * ("no supported assessment binding", "Gate v2 evidence"), so the rendering
 * layer maps known codes to direct sentences and falls back to the raw message
 * for codes this module does not know yet. The gate package is never edited to
 * suit the UI.
 */
export function gateReasonSentence(reason: { code: string; message: string }): string {
  switch (reason.code) {
    case "ASSESSMENT_UNAVAILABLE":
      return "No completed scan assessment exists yet. Run a scan to create one."
    case "EXPECTED_IDENTITY_REQUIRED":
    case "EXPECTED_IDENTITY_MISSING":
      return "Name the exact commit or artifact this launch covers so the verdict can be checked against it."
    case "IDENTITY_MISMATCH":
      return "The last assessment was for a different commit or artifact. Run a new scan for this release."
    case "UNSUPPORTED_IDENTITY":
      return "The release identity for this launch does not match what the assessment can cover."
    case "ASSESSMENT_EXPIRED":
      return "The last assessment is more than 24 hours old. Run a new scan to refresh it."
    case "POLICY_CHANGED":
      return "The scan policy changed after the last assessment. Run a new scan under the current policy."
    case "NEWER_ASSESSMENT_ATTEMPT":
      return "A newer scan attempt is still running. Wait for it to finish before deciding."
    case "EVIDENCE_CHANGED":
      return "Findings or verification evidence changed after the last assessment. Run a new scan to confirm the verdict still holds."
    case "NO_GATE_VERDICT":
      return "No completed scan verdict exists for this target yet. Run a scan first."
    case "APPLICABILITY_EVALUATION_FAILED":
      return "The issue-time applicability check could not be completed. Generate a fresh report to re-check."
    default:
      return reason.message
  }
}

/**
 * Present the canonical Gate v2 result with score data retained only as triage
 * context. This adapter does not make a readiness decision from scores or
 * finding workflow states.
 */
/**
 * Human description of the release identity a target's verdict covers. Used
 * to label ready verdicts on read-only surfaces: "commit abc1234" (short
 * hash) or "artifact sha256:abcd1234…" (first 19 chars). Returns null when
 * the target has no identity to describe.
 */
export function describeGateIdentity(
  target: Pick<GateReadinessTarget, "identity" | "state">
): string | null {
  if (!target.identity) return null
  if (target.identity.kind === "COMMIT") {
    const short = target.identity.value.slice(0, 7)
    return `Ready for commit ${short}`
  }
  return `Ready for artifact ${target.identity.value.slice(0, 19)}`
}

/**
 * Target-specific release check — input contract shared by the page, the API
 * route, and the client form. A release reference is a full 40-hex commit SHA
 * or a `sha256:`-prefixed 64-hex artifact digest; the two are mutually
 * exclusive and nothing shorter or tag-shaped is resolved.
 */
export const RELEASE_COMMIT_PATTERN = /^[a-f0-9]{40}$/i
export const RELEASE_ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i

export interface ReleaseIdentityInput {
  kind: "COMMIT" | "ARTIFACT_DIGEST"
  value: string
}

/**
 * Canonicalize a user-supplied release reference. Trims permitted whitespace
 * and lowercases hex (the gate compares case-insensitively); anything that is
 * not an exact supported identifier returns null rather than being
 * interpreted. Branch names, tags, and abbreviated prefixes are never
 * resolved to a release.
 */
export function parseReleaseReference(raw: string | null | undefined): ReleaseIdentityInput | null {
  const value = raw?.trim() ?? ""
  if (RELEASE_COMMIT_PATTERN.test(value)) return { kind: "COMMIT", value: value.toLowerCase() }
  if (RELEASE_ARTIFACT_DIGEST_PATTERN.test(value)) {
    return { kind: "ARTIFACT_DIGEST", value: value.toLowerCase() }
  }
  return null
}

export function resolveReleaseCheckTargetId(
  requestedTargetId: string,
  checkRequested: boolean,
  authorizedTargetIds: string[]
): string {
  return (
    requestedTargetId ||
    (checkRequested && authorizedTargetIds.length === 1 ? authorizedTargetIds[0]! : "")
  )
}

export type ReleaseCheckMatch = "match" | "mismatch" | "cannot_confirm"

export interface ReleaseCheckResult {
  /** The target the check ran against (null when the id resolves to nothing). */
  targetId: string
  targetName: string | null
  requested: ReleaseIdentityInput | null
  /** The release the retained assessment actually covers. */
  assessed: ReleaseIdentityInput | null
  match: ReleaseCheckMatch
  /** Immutable historical verdict for the bound assessment (null: none exists). */
  historicalState: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE" | null
  /** Effective state after applicability rules against the requested identity. */
  state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE"
  applicable: boolean
  blockingFindings: number
  reasons: { code: string; message: string }[]
}

/**
 * Project the release check for one target. Identity comparison is kept
 * deliberately separate from applicability: a matching release can still be
 * NOT_READY or expired, and a mismatch fails closed to INSUFFICIENT_EVIDENCE
 * through the existing gate rules — never through the label alone.
 */
export function describeReleaseCheck(
  target:
    | Pick<
        GateReadinessTarget,
        | "targetId"
        | "targetName"
        | "state"
        | "historicalState"
        | "applicable"
        | "blockingFindings"
        | "reasons"
        | "assessedIdentity"
      >
    | null
    | undefined,
  requested: ReleaseIdentityInput | null
): ReleaseCheckResult {
  const assessed = target?.assessedIdentity ?? null
  let match: ReleaseCheckMatch
  if (!requested) {
    match = "cannot_confirm"
  } else if (!assessed || assessed.kind !== requested.kind) {
    // No retained binding (or a binding for a different identity kind): the
    // assessment cannot speak for this release reference.
    match = "cannot_confirm"
  } else {
    match = assessed.value.toLowerCase() === requested.value.toLowerCase() ? "match" : "mismatch"
  }
  return {
    targetId: target?.targetId ?? "",
    targetName: target?.targetName ?? null,
    requested,
    assessed,
    match,
    historicalState: target?.historicalState ?? null,
    state: target?.state ?? "INSUFFICIENT_EVIDENCE",
    applicable: target?.applicable ?? false,
    blockingFindings: target?.blockingFindings ?? 0,
    reasons: target?.reasons ?? [{ code: "NO_GATE_VERDICT", message: "No assessment exists." }],
  }
}

export function projectGateReadinessReport(
  groups: FindingReadinessAggregate[],
  targets: GateReadinessTarget[]
): CanonicalLaunchReadinessReport {
  const triage = generateLaunchReadinessReportFromAggregate(groups, targets.length > 0)
  if (targets.length === 0) {
    return {
      ...triage,
      state: "INSUFFICIENT_EVIDENCE",
      verdict: "NOT_EVALUATED",
      score: null,
      triageScore: triage.score,
      summary: "No active target is available for a launch assessment.",
      conditions: ["Add a target and complete a scoped assessment."],
    }
  }

  const blockingFindings = targets.reduce((sum, target) => sum + target.blockingFindings, 0)
  const notReady = targets.filter((target) => target.state === "NOT_READY")
  const insufficient = targets.filter(
    (target) => target.state === "INSUFFICIENT_EVIDENCE" || !target.applicable
  )
  const conditions = targets.flatMap((target) =>
    target.reasons.map((reason) => `${target.targetName}: ${gateReasonSentence(reason)}`)
  )

  if (notReady.length > 0) {
    return {
      ...triage,
      state: "NOT_READY",
      verdict: "NO_GO",
      score: null,
      triageScore: triage.score,
      blockingFindings,
      summary: `${notReady.length} target assessment(s) are not ready.`,
      conditions:
        conditions.length > 0
          ? conditions
          : ["Resolve the blocking findings and complete a trusted retest."],
    }
  }

  if (insufficient.length > 0) {
    return {
      ...triage,
      state: "INSUFFICIENT_EVIDENCE",
      verdict: "INCONCLUSIVE",
      score: null,
      triageScore: triage.score,
      blockingFindings,
      summary: `${insufficient.length} of ${targets.length} target assessment(s) could not be reused — their evidence is missing or out of date.`,
      conditions:
        conditions.length > 0
          ? conditions
          : ["Run a current assessment bound to the release commit or artifact digest."],
    }
  }

  // 1.1: label what the READY verdicts actually cover — the assessment's own
  // identity when none was enforced, so "ready" never reads as an unscoped
  // all-clear.
  const identityLabels = targets
    .map((target) => describeGateIdentity(target))
    .filter((label): label is string => label !== null)

  return {
    ...triage,
    state: "READY",
    verdict: "GO",
    score: null,
    triageScore: triage.score,
    blockingFindings,
    summary:
      identityLabels.length > 0
        ? `All ${targets.length} active target assessment(s) are ready and currently applicable. ${identityLabels.join(" · ")}`
        : `All ${targets.length} active target assessment(s) are ready and currently applicable.`,
    conditions: [],
  }
}
