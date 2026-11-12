import { describe, expect, it } from "vitest"
import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  type GateEvidenceInput,
} from "@lyrashield/gate"
import { matchesCurrentGateEvidence } from "./gate-reader-evidence"

const input: GateEvidenceInput = {
  targetId: "target",
  latestCompletedScan: { id: "scan", endedAtMs: 1000, status: "COMPLETED", mode: "STANDARD" },
  coverageReceipts: [{ controlId: "sca", scanner: "sca", status: "COMPLETED", reason: null }],
  findings: [],
  requiredScanners: ["sca"],
  targetTypeCovered: true,
  policyFingerprint: "policy",
  assessmentIdentityComplete: true,
}
function row() {
  const verdict = computeGateVerdict(input)
  return {
    ...verdict,
    inputChecksum: computeInputChecksum(input),
    verdictChecksum: computeVerdictChecksum(verdict),
  }
}

describe("current gate semantics", () => {
  it("accepts a verdict faithfully recomputed from its verified inputs", () => {
    expect(matchesCurrentGateEvidence(row(), input)).toBe(true)
  })
  it("rejects a claimed READY when required coverage is missing even if the stored verdict checksum is self-consistent", () => {
    const missing = { ...input, coverageReceipts: [] }
    const forged = { ...computeGateVerdict(missing), state: "READY" as const }
    expect(
      matchesCurrentGateEvidence(
        {
          ...forged,
          inputChecksum: computeInputChecksum(missing),
          verdictChecksum: computeVerdictChecksum(forged),
        },
        missing
      )
    ).toBe(false)
  })
  it("does not enforce READY when a finding was observed after the assessment", () => {
    const stale: GateEvidenceInput = {
      ...input,
      findings: [
        {
          id: "f",
          severity: "LOW",
          status: "OPEN",
          verificationStatus: "VERIFIED",
          retestConfirmedResolved: false,
          hasPositiveEvidence: true,
          hasApplicableDisposition: false,
          applicableDisposition: null,
          duplicateCanonicalResolved: false,
          lastSeenAtMs: 2000,
        },
      ],
    }
    const verdict = computeGateVerdict(stale)
    expect(verdict.state).toBe("READY")
    expect(
      matchesCurrentGateEvidence(
        {
          ...verdict,
          inputChecksum: computeInputChecksum(stale),
          verdictChecksum: computeVerdictChecksum(verdict),
        },
        stale
      )
    ).toBe(false)
  })

  it("rejects an altered state or changed mode", () => {
    expect(matchesCurrentGateEvidence({ ...row(), state: "NOT_READY" }, input)).toBe(false)
    expect(
      matchesCurrentGateEvidence(row(), {
        ...input,
        latestCompletedScan: { ...input.latestCompletedScan!, mode: "SAFE" },
      })
    ).toBe(false)
  })
})
