import type { GateVerdictState } from "./index"

export const GATE_ASSESSMENT_VERSION = 2
export const GATE_FRESHNESS_MS = 24 * 60 * 60 * 1000

export type GateAssessmentIdentity =
  { kind: "COMMIT"; value: string } | { kind: "ARTIFACT_DIGEST"; value: string }

export interface GateAssessmentSnapshot {
  version: number
  scanId: string
  completedAtMs: number
  manifestChecksum: string
  manifestVersion: number
  policyId: string
  policyFingerprint: string
  identity: GateAssessmentIdentity
}

export interface GateApplicabilityReason {
  code:
    | "ASSESSMENT_UNAVAILABLE"
    | "EXPECTED_IDENTITY_REQUIRED"
    | "IDENTITY_MISMATCH"
    | "UNSUPPORTED_IDENTITY"
    | "ASSESSMENT_EXPIRED"
    | "POLICY_CHANGED"
    | "NEWER_ASSESSMENT_ATTEMPT"
    | "EVIDENCE_CHANGED"
  message: string
}

export interface GateApplicabilityInput {
  snapshot: GateAssessmentSnapshot | null
  expectedCommit?: string | null
  expectedArtifactDigest?: string | null
  policyFingerprint: string | null
  nowMs: number
  newerAssessmentAttempt: boolean
  evidenceChanged: boolean
}

export interface GateApplicabilityResult {
  applicable: boolean
  reasons: GateApplicabilityReason[]
  effectiveState: GateVerdictState
}

/**
 * Applies a persisted assessment to the release identity being enforced. This
 * is separate from the historical verdict: any failed applicability check must
 * fail closed without rewriting immutable history.
 */
export function evaluateGateApplicability(
  historicalState: GateVerdictState,
  input: GateApplicabilityInput
): GateApplicabilityResult {
  const reasons: GateApplicabilityReason[] = []
  const snapshot = input.snapshot
  const expectedIdentity = input.expectedCommit
    ? ({ kind: "COMMIT", value: input.expectedCommit } as const)
    : input.expectedArtifactDigest
      ? ({ kind: "ARTIFACT_DIGEST", value: input.expectedArtifactDigest } as const)
      : null

  if (!snapshot || snapshot.version !== GATE_ASSESSMENT_VERSION) {
    reasons.push({
      code: "ASSESSMENT_UNAVAILABLE",
      message: "This historical verdict has no supported assessment binding.",
    })
  }
  if (!expectedIdentity) {
    reasons.push({
      code: "EXPECTED_IDENTITY_REQUIRED",
      message: "Provide the commit or artifact digest being enforced.",
    })
  } else if (snapshot && snapshot.identity.kind !== expectedIdentity.kind) {
    reasons.push({
      code: "UNSUPPORTED_IDENTITY",
      message: "The assessment cannot establish this kind of release identity.",
    })
  } else if (snapshot && snapshot.identity.value !== expectedIdentity?.value) {
    reasons.push({
      code: "IDENTITY_MISMATCH",
      message: "The assessment identity does not match the release being enforced.",
    })
  }
  if (snapshot && input.nowMs >= snapshot.completedAtMs + GATE_FRESHNESS_MS) {
    reasons.push({
      code: "ASSESSMENT_EXPIRED",
      message: "The assessment expired after 24 hours and must be refreshed.",
    })
  }
  if (snapshot && input.policyFingerprint !== snapshot.policyFingerprint) {
    reasons.push({
      code: "POLICY_CHANGED",
      message: "The target policy changed after this assessment.",
    })
  }
  if (input.newerAssessmentAttempt) {
    reasons.push({
      code: "NEWER_ASSESSMENT_ATTEMPT",
      message: "A newer assessment attempt must finish before this verdict can be reused.",
    })
  }
  if (input.evidenceChanged) {
    reasons.push({
      code: "EVIDENCE_CHANGED",
      message: "Finding or verification evidence changed after this verdict.",
    })
  }

  return {
    applicable: reasons.length === 0,
    reasons,
    effectiveState: reasons.length === 0 ? historicalState : "INSUFFICIENT_EVIDENCE",
  }
}
