import { describe, expect, it } from "vitest"

import {
  computeGateVerdict,
  GATE_STANDARD_VERSION,
  isTargetTypeCovered,
  requiredScannersForTarget,
  type GateEvidenceInput,
  type GateFindingSeverity,
  type GateVerificationStatus,
} from "./index"
import { computeInputChecksum, computeVerdictChecksum } from "./checksum"

const REPO_REQUIRED = requiredScannersForTarget("REPO")

function fullCoverage(): GateEvidenceInput["coverageReceipts"] {
  return REPO_REQUIRED.map((family) => ({
    controlId: family,
    scanner: family,
    status: "COMPLETED" as const,
    reason: null,
  }))
}

function baseInput(overrides: Partial<GateEvidenceInput> = {}): GateEvidenceInput {
  return {
    targetId: "target-1",
    latestCompletedScan: { id: "scan-1", endedAtMs: 1_000_000, status: "COMPLETED" },
    coverageReceipts: fullCoverage(),
    findings: [],
    requiredScanners: REPO_REQUIRED,
    targetTypeCovered: true,
    ...overrides,
  }
}

describe("gate standard versioning", () => {
  it("is named and versioned", () => {
    expect(GATE_STANDARD_VERSION).toBe("lyrashield-gate/1.0.0")
  })

  it("derives required scanners per target type", () => {
    expect(requiredScannersForTarget("REPO")).toContain("engine")
    expect(requiredScannersForTarget("REPO")).toContain("secrets")
    expect(isTargetTypeCovered("REPO")).toBe(true)
    // Deferred target types report not-covered, never "nothing required".
    expect(isTargetTypeCovered("IAC")).toBe(false)
    expect(requiredScannersForTarget("IAC")).toEqual([])
  })
})

describe("computeGateVerdict", () => {
  it("READY when coverage is complete and there are no blockers", () => {
    const result = computeGateVerdict(baseInput())
    expect(result.state).toBe("READY")
    expect(result.standardVersion).toBe(GATE_STANDARD_VERSION)
    expect(result.nonCoverage).toEqual([])
    expect(result.coverageStatement.length).toBe(REPO_REQUIRED.length)
    expect(result.blockingReasons).toEqual([])
  })

  it("INSUFFICIENT_EVIDENCE when no scanner completed (absence of evidence is not a clean result)", () => {
    const result = computeGateVerdict(
      baseInput({
        coverageReceipts: fullCoverage().map((r) => ({ ...r, status: "BLOCKED" as const })),
      })
    )
    expect(result.state).toBe("INSUFFICIENT_EVIDENCE")
    expect(result.nonCoverage.length).toBe(REPO_REQUIRED.length)
  })

  it("INSUFFICIENT_EVIDENCE when a required scanner class is missing", () => {
    const result = computeGateVerdict(
      baseInput({ coverageReceipts: fullCoverage().filter((r) => r.scanner !== "secrets") })
    )
    expect(result.state).toBe("INSUFFICIENT_EVIDENCE")
  })

  it("NOT_READY on an unresolved CRITICAL finding, traceable to the finding", () => {
    const result = computeGateVerdict(
      baseInput({
        findings: [
          {
            id: "f-crit",
            severity: "CRITICAL",
            status: "OPEN",
            verificationStatus: "VERIFIED",
            retestConfirmedResolved: false,
            lastSeenAtMs: 900_000,
          },
        ],
      })
    )
    expect(result.state).toBe("NOT_READY")
    expect(result.blockingReasons).toEqual([
      { findingId: "f-crit", severity: "CRITICAL", verificationStatus: "VERIFIED" },
    ])
  })

  it("does NOT block on MEDIUM in v1.0.0 (founder-confirmed)", () => {
    const result = computeGateVerdict(
      baseInput({
        findings: [
          {
            id: "f-med",
            severity: "MEDIUM",
            status: "OPEN",
            verificationStatus: "VERIFIED",
            retestConfirmedResolved: false,
            lastSeenAtMs: 900_000,
          },
        ],
      })
    )
    expect(result.state).toBe("READY")
  })

  it("a retest-confirmed-resolved finding stops blocking", () => {
    const result = computeGateVerdict(
      baseInput({
        findings: [
          {
            id: "f-fixed",
            severity: "CRITICAL",
            status: "FIXED_PENDING_RETEST",
            verificationStatus: "VERIFIED",
            retestConfirmedResolved: true,
            lastSeenAtMs: 900_000,
          },
        ],
      })
    )
    expect(result.state).toBe("READY")
    expect(result.evidenceSummary.retestConfirmed).toBe(1)
  })

  it("marks stale when a finding is newer than the latest completed scan", () => {
    const result = computeGateVerdict(
      baseInput({
        findings: [
          {
            id: "f-new",
            severity: "LOW",
            status: "OPEN",
            verificationStatus: "DETECTED",
            retestConfirmedResolved: false,
            lastSeenAtMs: 2_000_000, // after scan end 1_000_000
          },
        ],
      })
    )
    expect(result.staleness.current).toBe(false)
    expect(result.staleness.reason).toMatch(/re-run the gate/i)
  })

  it("orders blocking reasons by severity (CRITICAL before HIGH)", () => {
    const result = computeGateVerdict(
      baseInput({
        findings: [
          {
            id: "f-high",
            severity: "HIGH",
            status: "OPEN",
            verificationStatus: "VERIFIED",
            retestConfirmedResolved: false,
            lastSeenAtMs: 900_000,
          },
          {
            id: "f-crit",
            severity: "CRITICAL",
            status: "OPEN",
            verificationStatus: "VERIFIED",
            retestConfirmedResolved: false,
            lastSeenAtMs: 900_000,
          },
        ],
      })
    )
    expect(result.blockingReasons.map((b) => b.findingId)).toEqual(["f-crit", "f-high"])
  })
})

describe("reproducibility (load-bearing determinism guarantee)", () => {
  it("same evidence yields the same verdict and checksums", () => {
    const input = baseInput({
      findings: [
        {
          id: "f1",
          severity: "HIGH",
          status: "OPEN",
          verificationStatus: "VERIFIED",
          retestConfirmedResolved: false,
          lastSeenAtMs: 900_000,
        },
      ],
    })
    const a = computeGateVerdict(input)
    const b = computeGateVerdict(input)
    expect(a).toEqual(b)
    expect(computeInputChecksum(input)).toBe(computeInputChecksum(input))
    expect(computeVerdictChecksum(a)).toBe(computeVerdictChecksum(b))
  })

  it("input checksum is independent of array order", () => {
    const receipts = fullCoverage()
    const reversed = [...receipts].reverse()
    expect(computeInputChecksum(baseInput({ coverageReceipts: receipts }))).toBe(
      computeInputChecksum(baseInput({ coverageReceipts: reversed }))
    )
  })

  it("checksum changes when evidence changes (tamper-evident)", () => {
    const clean = baseInput()
    const withFinding = baseInput({
      findings: [
        {
          id: "f1",
          severity: "CRITICAL",
          status: "OPEN",
          verificationStatus: "VERIFIED",
          retestConfirmedResolved: false,
          lastSeenAtMs: 900_000,
        },
      ],
    })
    expect(computeInputChecksum(clean)).not.toBe(computeInputChecksum(withFinding))
  })
})

describe("GATE-0 target-type coverage", () => {
  it("never issues READY for a target type the standard does not cover, even with completed receipts", () => {
    // This is the regression the uncovered-type fallthrough needed: a
    // CLOUD_ACCOUNT/CONTAINER/IAC target with an empty requiredScanners list
    // previously fell through to READY because no scanners were missing.
    const verdict = computeGateVerdict(
      baseInput({ requiredScanners: [], targetTypeCovered: false })
    )
    expect(verdict.state).toBe("INSUFFICIENT_EVIDENCE")
    expect(verdict.coverageStatement).toEqual([])
    expect(verdict.staleness.current).toBe(false)
    expect(verdict.staleness.reason).toContain("not covered")
  })

  it("still evaluates normally for covered types", () => {
    expect(computeGateVerdict(baseInput()).state).toBe("READY")
  })
})

describe("evidenceSummary per-severity unresolved counts", () => {
  const finding = (
    id: string,
    severity: GateFindingSeverity,
    status = "OPEN",
    verificationStatus: GateVerificationStatus = "VERIFIED"
  ) => ({
    id,
    severity,
    status,
    verificationStatus,
    retestConfirmedResolved: false,
    lastSeenAtMs: 900_000,
  })

  it("counts unresolved CRITICAL and HIGH; MEDIUM/LOW are not counted (not gate-evaluated)", () => {
    const verdict = computeGateVerdict(
      baseInput({
        findings: [
          finding("f1", "CRITICAL"),
          finding("f2", "HIGH"),
          finding("f3", "HIGH", "FIXED", "VERIFIED"),
          finding("f4", "MEDIUM"),
          finding("f5", "LOW"),
        ],
      })
    )
    expect(verdict.state).toBe("NOT_READY")
    expect(verdict.evidenceSummary.unresolvedCritical).toBe(1)
    expect(verdict.evidenceSummary.unresolvedHigh).toBe(1) // f2 unresolved; f3 is FIXED so not blocking
  })

  it("does not count retest-confirmed-resolved findings as unresolved", () => {
    const verdict = computeGateVerdict(
      baseInput({
        findings: [
          {
            id: "f1",
            severity: "CRITICAL",
            status: "OPEN",
            verificationStatus: "VERIFIED",
            retestConfirmedResolved: true,
            lastSeenAtMs: 900_000,
          },
        ],
      })
    )
    expect(verdict.state).toBe("READY")
    expect(verdict.evidenceSummary.unresolvedCritical).toBe(0)
  })
})
