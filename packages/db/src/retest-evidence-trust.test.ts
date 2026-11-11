import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { isReceiptBackedRetest } from "./retest-evidence-trust"

function fixture(targetType: "REPO" | "WEB_APP" = "REPO") {
  const identity = (scanId: string, revision: string) => {
    const manifest = {
      target: { id: "target-1", type: targetType, urlChecksum: "a".repeat(64) },
      sourceExecution: { sourceRevision: revision },
      terminalOutcome: { status: "COMPLETED" },
      coverage: [{ scanner: "sca", controlId: "sca", status: "COMPLETED" }],
    }
    const checksumInput = JSON.stringify(manifest)
    const checksum = createHash("sha256").update(checksumInput).digest("hex")
    return {
      scan: {
        id: scanId,
        workspaceId: "workspace-1",
        targetId: "target-1",
        status: "COMPLETED",
        resultManifest: { checksum, checksumInput, manifest },
        coverageReceipts: [
          {
            id: `coverage-${scanId}`,
            scanId,
            scanner: "sca",
            controlId: "sca",
            status: "COMPLETED",
            reason: null,
            subject: null,
            metadata: null,
          },
        ],
      },
      evidence: {
        scanId,
        manifestChecksum: checksum,
        sourceRevision: revision,
        targetUrlChecksum: "a".repeat(64),
      },
    }
  }
  const baseline = identity("baseline", "b".repeat(40))
  const retestScan = identity("retest-scan", "c".repeat(40))
  return {
    workspaceId: "workspace-1",
    targetId: "target-1",
    finding: { id: "finding-1", scanId: "baseline" },
    receipt: {
      status: "VALIDATED",
      method: "RETEST",
      scanId: "retest-scan",
      verifierVersion: "result-integrity-v3",
      evidence: {
        retestId: "retest-1",
        scannerSource: "sca",
        baseline: baseline.evidence,
        retest: retestScan.evidence,
        coverageReceiptIds: ["coverage-baseline", "coverage-retest-scan"],
      },
    },
    retest: {
      id: "retest-1",
      workspaceId: "workspace-1",
      findingId: "finding-1",
      scanId: "retest-scan",
      status: "passed",
    },
    baseline: baseline.scan,
    retestScan: retestScan.scan,
    sourceCandidates: [{ scannerSource: "sca", payload: {} }],
    observedInRetest: false,
  }
}

describe("receipt-backed deterministic retest", () => {
  it("accepts complete repository and URL identity with verified stored manifests", () => {
    expect(isReceiptBackedRetest(fixture())).toBe(true)
    expect(isReceiptBackedRetest(fixture("WEB_APP"))).toBe(true)
  })

  it("rejects legacy, foreign, incomplete, and tampered evidence", () => {
    const legacy = fixture()
    legacy.receipt.evidence.baseline.manifestChecksum = ""
    const foreign = fixture()
    foreign.retest.workspaceId = "workspace-2"
    const incomplete = fixture()
    incomplete.retestScan.coverageReceipts[0]!.status = "INCOMPLETE"
    const tampered = fixture()
    tampered.baseline.resultManifest.manifest.sourceExecution.sourceRevision = "d".repeat(40)
    const wrongReceipt = fixture()
    wrongReceipt.receipt.evidence.coverageReceiptIds[1] = "foreign-coverage"
    const observed = fixture()
    observed.observedInRetest = true
    const unknownSource = fixture()
    unknownSource.sourceCandidates[0]!.scannerSource = "engine"
    const mismatchedUrl = fixture("WEB_APP")
    mismatchedUrl.receipt.evidence.retest.targetUrlChecksum = "b".repeat(64)
    const contradictory = fixture()
    contradictory.baseline.resultManifest.manifest.coverage[0]!.status = "BLOCKED"
    contradictory.baseline.resultManifest.checksumInput = JSON.stringify(
      contradictory.baseline.resultManifest.manifest
    )
    contradictory.baseline.resultManifest.checksum = createHash("sha256")
      .update(contradictory.baseline.resultManifest.checksumInput)
      .digest("hex")
    contradictory.receipt.evidence.baseline.manifestChecksum =
      contradictory.baseline.resultManifest.checksum

    for (const value of [
      legacy,
      foreign,
      incomplete,
      tampered,
      wrongReceipt,
      observed,
      unknownSource,
      mismatchedUrl,
      contradictory,
    ]) {
      expect(isReceiptBackedRetest(value)).toBe(false)
    }
  })
})
