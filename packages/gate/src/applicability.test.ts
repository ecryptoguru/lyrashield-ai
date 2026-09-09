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

  it("fails closed for a different enforced release identity and at expiry", () => {
    // No expected identity = read mode: the snapshot's own identity is used
    // and the verdict stands (covered in the non-enforcing describe block).
    const expired = evaluateGateApplicability("READY", {
      snapshot,
      expectedCommit: "c".repeat(40),
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs + GATE_FRESHNESS_MS,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(expired).toMatchObject({ applicable: false, effectiveState: "INSUFFICIENT_EVIDENCE" })
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

describe("gate applicability — non-enforcing read mode", () => {
  // Read-only surfaces (Home, Launch Readiness) supply no release identity.
  // The assessment is evaluated against its OWN identity so a usable verdict
  // is reachable, and the identity is returned for labelling. Every other
  // reason — freshness, policy drift, newer attempt, evidence change — still
  // fails closed exactly as in enforcing mode.

  it("evaluates a current snapshot against its own identity and returns that identity", () => {
    const result = evaluateGateApplicability("READY", {
      snapshot,
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs + GATE_FRESHNESS_MS - 1,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(result).toMatchObject({
      applicable: true,
      effectiveState: "READY",
      evaluatedIdentity: snapshot.identity,
    })
  })

  it("fails closed when no snapshot exists", () => {
    const result = evaluateGateApplicability("READY", {
      snapshot: null,
      policyFingerprint: null,
      nowMs: 1_000,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(result).toMatchObject({
      applicable: false,
      effectiveState: "INSUFFICIENT_EVIDENCE",
      evaluatedIdentity: null,
    })
    expect(result.reasons.map((reason) => reason.code)).toContain("ASSESSMENT_UNAVAILABLE")
  })

  it("still expires a stale snapshot in read mode", () => {
    const result = evaluateGateApplicability("READY", {
      snapshot,
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs + GATE_FRESHNESS_MS,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(result).toMatchObject({
      applicable: false,
      effectiveState: "INSUFFICIENT_EVIDENCE",
      evaluatedIdentity: snapshot.identity,
    })
    expect(result.reasons.map((reason) => reason.code)).toContain("ASSESSMENT_EXPIRED")
  })

  it("still fails closed on policy drift in read mode", () => {
    const result = evaluateGateApplicability("READY", {
      snapshot,
      policyFingerprint: "policy-2",
      nowMs: snapshot.completedAtMs,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(result).toMatchObject({ applicable: false, effectiveState: "INSUFFICIENT_EVIDENCE" })
    expect(result.reasons.map((reason) => reason.code)).toContain("POLICY_CHANGED")
  })

  it("still fails closed on evidence change and newer attempt in read mode", () => {
    const result = evaluateGateApplicability("READY", {
      snapshot,
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs,
      newerAssessmentAttempt: true,
      evidenceChanged: true,
    })
    expect(result).toMatchObject({ applicable: false, effectiveState: "INSUFFICIENT_EVIDENCE" })
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["NEWER_ASSESSMENT_ATTEMPT", "EVIDENCE_CHANGED"])
    )
  })

  it("keeps strict mismatch behaviour whenever an identity IS enforced", () => {
    const mismatch = evaluateGateApplicability("READY", {
      snapshot,
      expectedCommit: "c".repeat(40),
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(mismatch).toMatchObject({ applicable: false, effectiveState: "INSUFFICIENT_EVIDENCE" })
    expect(mismatch.reasons.map((reason) => reason.code)).toContain("IDENTITY_MISMATCH")
    expect(mismatch.evaluatedIdentity).toEqual({ kind: "COMMIT", value: "c".repeat(40) })

    const kindMismatch = evaluateGateApplicability("READY", {
      snapshot,
      expectedArtifactDigest: "sha256:" + "d".repeat(64),
      policyFingerprint: "policy-1",
      nowMs: snapshot.completedAtMs,
      newerAssessmentAttempt: false,
      evidenceChanged: false,
    })
    expect(kindMismatch.reasons.map((reason) => reason.code)).toContain("UNSUPPORTED_IDENTITY")
  })
})
