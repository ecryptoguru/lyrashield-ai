import { describe, expect, it, vi } from "vitest"
import { findMismatchedGateEvidence } from "./gate-reader-evidence"
import type { ScopedTransaction } from "./rls"

vi.mock("./retest-evidence-trust", () => ({
  loadReceiptBackedRetestFindingIdsAcrossTargets: vi.fn(
    async (_tx, input) =>
      new Set(
        input.findings
          .filter((finding: { id: string }) => finding.id === "trusted")
          .map((finding: { id: string }) => finding.id)
      )
  ),
}))

const summary = {
  detected: 1,
  validated: 0,
  verified: 0,
  retestConfirmed: 1,
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
function finding(id: string, targetId: string) {
  return {
    id,
    targetId,
    severity: "HIGH",
    status: "FIXED",
    verificationStatus: "DETECTED",
    scanId: `baseline-${id}`,
    dedupeKey: id,
    lastSeenAt: new Date(0),
    disposition: null,
    dispositionActorUserId: null,
    dispositionReason: null,
    dispositionAssessmentId: null,
    dispositionAt: null,
    canonicalFindingId: null,
    verificationReceipts: [
      {
        status: "VALIDATED",
        method: "RETEST",
        scanId: `scan-${targetId}`,
        verifierVersion: "result-integrity-v2",
        evidence: {},
      },
    ],
  }
}

describe("gate reader retest compatibility", () => {
  it("fails a weak legacy result closed while retaining a receipt-backed result in one batch", async () => {
    const rows = [finding("weak", "weak-target"), finding("trusted", "trusted-target")]
    const findMany = vi.fn().mockResolvedValue(rows)
    const tx = { $queryRaw: findMany } as unknown as ScopedTransaction
    const mismatches = await findMismatchedGateEvidence(tx, "workspace", [
      {
        targetId: "weak-target",
        scanId: "scan-weak-target",
        evidenceSummary: summary,
        blockingReasons: [],
      },
      {
        targetId: "trusted-target",
        scanId: "scan-trusted-target",
        evidenceSummary: summary,
        blockingReasons: [],
      },
    ])
    expect([...mismatches]).toEqual(["weak-target"])
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0]![1]).toEqual(["weak-target", "trusted-target"])
    expect(findMany.mock.calls[0]![2]).toBe("workspace")
  })

  it("does not treat RETEST as independent positive evidence for an unresolved medium finding", async () => {
    const row = { ...finding("weak", "target"), severity: "MEDIUM", status: "OPEN" }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([row]),
    } as unknown as ScopedTransaction
    const oldSummary = {
      ...summary,
      retestConfirmed: 0,
      unresolvedMedium: 1,
      blockingUnverified: 1,
    }
    const mismatches = await findMismatchedGateEvidence(tx, "workspace", [
      {
        targetId: "target",
        scanId: "scan-target",
        evidenceSummary: oldSummary,
        blockingReasons: [],
      },
    ])
    expect([...mismatches]).toEqual(["target"])
  })
  it("fails closed when the finding set exceeds the bounded batch limit", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 10001 }, () => finding("weak", "target"))),
    } as unknown as ScopedTransaction
    expect([
      ...(await findMismatchedGateEvidence(tx, "workspace", [
        {
          targetId: "target",
          scanId: "scan-target",
          evidenceSummary: summary,
          blockingReasons: [],
        },
      ])),
    ]).toEqual(["target"])
  })

  it("fails a duplicate whose canonical finding relied on an untrusted retest", async () => {
    const canonical = { ...finding("weak", "target"), severity: "LOW", status: "OPEN" }
    const duplicate = {
      ...finding("duplicate", "target"),
      status: "DUPLICATE",
      canonicalFindingId: "weak",
      verificationReceipts: [],
    }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([canonical, duplicate]),
    } as unknown as ScopedTransaction
    const oldSummary = {
      ...summary,
      detected: 2,
      retestConfirmed: 0,
      unresolvedLow: 1,
      blockingUnverified: 1,
    }
    const result = await findMismatchedGateEvidence(tx, "workspace", [
      {
        targetId: "target",
        scanId: "scan-target",
        evidenceSummary: oldSummary,
        blockingReasons: [],
      },
    ])
    expect([...result]).toEqual(["target"])
  })

  it("detects a removed retest receipt rather than trusting a retained READY", async () => {
    const row = { ...finding("weak", "target"), verificationReceipts: [] }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([row]),
    } as unknown as ScopedTransaction
    const result = await findMismatchedGateEvidence(tx, "workspace", [
      { targetId: "target", scanId: "scan-target", evidenceSummary: summary, blockingReasons: [] },
    ])
    expect([...result]).toEqual(["target"])
  })
  it.each([null, {}, { detected: 0 }, { ...summary, detected: -1 }, { ...summary, unexpected: 0 }])(
    "fails closed for malformed empty evidence %j",
    async (evidenceSummary) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
      } as unknown as ScopedTransaction
      expect([
        ...(await findMismatchedGateEvidence(tx, "workspace", [
          { targetId: "t", scanId: "scan", evidenceSummary, blockingReasons: [] },
        ])),
      ]).toEqual(["t"])
    }
  )

  it.each([null, {}, [null], [{ findingId: null }]])(
    "fails closed for malformed blocking reasons %j",
    async (blockingReasons) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
      } as unknown as ScopedTransaction
      expect([
        ...(await findMismatchedGateEvidence(tx, "workspace", [
          {
            targetId: "t",
            scanId: "scan",
            evidenceSummary: Object.fromEntries(Object.keys(summary).map((k) => [k, 0])),
            blockingReasons,
          },
        ])),
      ]).toEqual(["t"])
    }
  )

  it("accepts a supported legacy all-zero evidence summary", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as ScopedTransaction
    const legacy = {
      detected: 0,
      validated: 0,
      verified: 0,
      retestConfirmed: 0,
      inconclusive: 0,
      blockingUnverified: 0,
    }
    expect([
      ...(await findMismatchedGateEvidence(tx, "workspace", [
        { targetId: "t", scanId: "scan", evidenceSummary: legacy, blockingReasons: [] },
      ])),
    ]).toEqual([])
  })
})
