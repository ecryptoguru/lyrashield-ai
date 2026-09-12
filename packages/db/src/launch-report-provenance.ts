/**
 * Launch report provenance — the PRIVATE issue-time binding stored on
 * Report.provenanceJson.
 *
 * This record is what lets an authenticated reader answer "which release and
 * which verdict does this report describe, and was that assessment still
 * usable when the report was issued". It is written once at issue and never
 * rewritten: reports are frozen artifacts, and provenance is the durable part
 * of that freeze.
 *
 * Disclosure boundary: this object is workspace-private. It must NOT be merged
 * into the signed public payload (buildLaunchReportPayload owns that allowlist),
 * shared-page renders, downloads, or public API responses. Authenticated report
 * readers only.
 */

export const LAUNCH_REPORT_PROVENANCE_VERSION = "lyrashield-report-provenance/1.0.0"

/**
 * Applicability could not be evaluated at issue (e.g. a mid-transaction read
 * failure). Stored instead of the raw exception so the record stays bounded
 * and user-safe; the diagnostic itself is logged, not persisted.
 */
export const APPLICABILITY_EVALUATION_FAILED = "APPLICABILITY_EVALUATION_FAILED"

export interface LaunchReportProvenance {
  schemaVersion: string
  /** The exact GateVerdict this report was issued from — never "latest". */
  gateVerdictId: string
  /** The verdict's own checksum, retained so the binding survives verdict deletion. */
  verdictChecksum: string
  /** GateAssessmentSnapshot version on the bound verdict (null for legacy verdicts). */
  assessmentVersion: number | null
  /** The release identity the ASSESSMENT retains (snapshot.identity), not a caller input. */
  assessedIdentity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
  /** ISO instant the bound verdict was evaluated (GateVerdict.evaluatedAt). */
  assessedAt: string
  /** ISO instant this report was issued. */
  issuedAt: string
  /**
   * ISO instant the applicability inputs were observed. For the issuance path
   * this is the timestamp supplied to the evaluator inside the consistent
   * (RepeatableRead) snapshot — one observation point for verdict + inputs.
   */
  applicabilityCheckedAt: string
  /**
   * "applicable" | "not_applicable" when the evaluation completed;
   * "unknown" when it could not — fail-closed, never silently "applicable".
   */
  applicability: "applicable" | "not_applicable" | "unknown"
  /** Bounded reason codes only (gate reason codes / APPLICABILITY_EVALUATION_FAILED). */
  reasonCodes: string[]
  /** The immutable verdict state the report renders (READY | NOT_READY | INSUFFICIENT_EVIDENCE). */
  historicalState: string
  /** The gate's effective state after applicability rules at issue time (null when unknown). */
  effectiveState: string | null
}

export function buildLaunchReportProvenance(input: {
  verdictId: string
  verdictChecksum: string
  assessmentVersion: number | null
  assessedIdentity: LaunchReportProvenance["assessedIdentity"]
  assessedAt: Date
  issuedAt: Date
  applicabilityCheckedAt: Date
  applicability: LaunchReportProvenance["applicability"]
  reasonCodes: string[]
  historicalState: string
  effectiveState: string | null
}): LaunchReportProvenance {
  return {
    schemaVersion: LAUNCH_REPORT_PROVENANCE_VERSION,
    gateVerdictId: input.verdictId,
    verdictChecksum: input.verdictChecksum,
    assessmentVersion: input.assessmentVersion,
    assessedIdentity: input.assessedIdentity,
    assessedAt: input.assessedAt.toISOString(),
    issuedAt: input.issuedAt.toISOString(),
    applicabilityCheckedAt: input.applicabilityCheckedAt.toISOString(),
    applicability: input.applicability,
    reasonCodes: input.reasonCodes.slice(0, 16),
    historicalState: input.historicalState,
    effectiveState: input.effectiveState,
  }
}

const IDENTITY_KINDS = new Set(["COMMIT", "ARTIFACT_DIGEST"])
const APPLICABILITY_OUTCOMES = new Set(["applicable", "not_applicable", "unknown"])

/**
 * Strict reader for stored provenance. Anything unparseable or from an unknown
 * schema version returns null — callers then show the explicit
 * "Release identity unavailable for this report" state rather than guessing.
 */
export function parseLaunchReportProvenance(value: unknown): LaunchReportProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== LAUNCH_REPORT_PROVENANCE_VERSION) return null
  const identity = raw.assessedIdentity
  const parsedIdentity =
    identity && typeof identity === "object" && !Array.isArray(identity)
      ? (() => {
          const candidate = identity as Record<string, unknown>
          return IDENTITY_KINDS.has(candidate.kind as string) &&
            typeof candidate.value === "string" &&
            candidate.value.length > 0
            ? { kind: candidate.kind as "COMMIT" | "ARTIFACT_DIGEST", value: candidate.value }
            : null
        })()
      : null
  if (
    typeof raw.gateVerdictId !== "string" ||
    typeof raw.verdictChecksum !== "string" ||
    typeof raw.assessedAt !== "string" ||
    typeof raw.issuedAt !== "string" ||
    typeof raw.applicabilityCheckedAt !== "string" ||
    !APPLICABILITY_OUTCOMES.has(raw.applicability as string) ||
    !Array.isArray(raw.reasonCodes) ||
    !raw.reasonCodes.every((code) => typeof code === "string") ||
    typeof raw.historicalState !== "string" ||
    (raw.effectiveState !== null && typeof raw.effectiveState !== "string")
  ) {
    return null
  }
  return {
    schemaVersion: raw.schemaVersion,
    gateVerdictId: raw.gateVerdictId,
    verdictChecksum: raw.verdictChecksum,
    assessmentVersion: typeof raw.assessmentVersion === "number" ? raw.assessmentVersion : null,
    assessedIdentity: parsedIdentity,
    assessedAt: raw.assessedAt,
    issuedAt: raw.issuedAt,
    applicabilityCheckedAt: raw.applicabilityCheckedAt,
    applicability: raw.applicability as LaunchReportProvenance["applicability"],
    reasonCodes: raw.reasonCodes as string[],
    historicalState: raw.historicalState,
    effectiveState: raw.effectiveState,
  }
}
