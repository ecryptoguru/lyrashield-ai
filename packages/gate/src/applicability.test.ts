import { describe, expect, it } from "vitest"
import { GATE_FRESHNESS_MS, evaluateGateApplicability, type GateAssessmentSnapshot } from "./index"

const snapshot: GateAssessmentSnapshot = {
  version: 2,
  scanId: "scan-1",
  completedAtMs: 1_000,
  manifestChecksum: "a".repeat(64),
  manifestVersion: 7,
  policyId: "policy-1",
  policyFingerprint: "policy-1",
  identity: { kind: "COMMIT", value: "b".repeat(40) },
}

describe("gate applicability", () => {
  it("approves only the assessed commit before the 24-hour boundary", () => {
    expect(
      evaluateGateApplicability("READY", {
        snapshot,
        expectedCommit: snapshot.identity.value,
        policyFingerprint: "policy-1",
        nowMs: snapshot.completedAtMs + GATE_FRESHNESS_MS - 1,
        newerAssessmentAttempt: false,
        evidenceChanged: false,
      })
    ).toMatchObject({ applicable: true, effectiveState: "READY" })
  })

  it("fails closed for a missing or different release identity and at expiry", () => {
    const missing = evaluateGateApplicability("READY", {
      snapshot,
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    const expired = evaluateGateApplicability("READY", {
      snapshot,
      expectedCommit: "c".repeat(40),
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs + GATE_FRESHNESS_MS,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(missing).toMatchObject({ applicable: false, effectiveState: "INSUFFICIENT_EVIDENCE" })
    expect(missing.reasons[0]?.code).toBe("EXPECTED_IDENTITY_REQUIRED")
    expect(expired.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["IDENTITY_MISMATCH", "ASSESSMENT_EXPIRED"])
    )
  })

  it("never lets evidence or newer work weaken into approval", () => {
    const result = evaluateGateApplicability("READY", {
      snapshot,
      expectedCommit: snapshot.identity.value,
      policyFingerprint: "policy-2",
      nowMs: snapshot.completedAtMs,
      newerAssessmentAttempt: true,
      evidenceChanged: true,
    })
    expect(result).toMatchObject({ applicable: false, effectiveState: "INSUFFICIENT_EVIDENCE" })
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["POLICY_CHANGED", "NEWER_ASSESSMENT_ATTEMPT", "EVIDENCE_CHANGED"])
    )
  })
})
