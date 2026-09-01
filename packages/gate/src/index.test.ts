import { describe, expect, it } from "vitest"

import {
  computeGateVerdict,
  GATE_STANDARD_VERSION,
  isTargetTypeCovered,
  requiredScannersForTarget,
  type GateEvidenceInput,
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
