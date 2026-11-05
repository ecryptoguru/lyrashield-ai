import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ReleasePacketPayload } from "@lyrashield/types"
import { ReleasePacketView } from "./release-packet-view"

const payload: ReleasePacketPayload = {
  version: "release_packet/1.0.0",
  packetChecksum: "a".repeat(64),
  generatedAt: "2026-11-05T00:00:00.000Z",
  target: { id: "target-1", name: "Release App", type: "REPO", environment: "PRODUCTION" },
  assessment: {
    verdictId: "verdict-1",
    standardVersion: "lyrashield-gate/2.4.0",
    state: "INSUFFICIENT_EVIDENCE",
    historicalState: "NOT_READY",
    applicable: false,
    reasons: [{ code: "EVIDENCE_CHANGED", message: "Evidence changed after assessment" }],
    evaluatedAt: "2026-11-05T00:00:00.000Z",
    assessedIdentity: { kind: "COMMIT", value: "b".repeat(40) },
    coverageStatement: ["sast"],
    nonCoverage: [{ controlId: "sca", scanner: "sca", reason: "feed unavailable" }],
  },
  signedAssessment: {
    state: "UNAVAILABLE",
    reportId: "report-1",
    reason: "verification key unavailable",
  },
  remediation: {
    baselineScanId: "scan-0",
    currentScanId: "scan-1",
    counts: { newFindings: 1, recurringFindings: 1, resolvedFindings: 1, uncertainMatches: 1 },
    findings: [
      {
        category: "uncertain",
        findingId: "finding-1",
        dedupeKey: "dedupe-1",
        title: "Potential tenant escape",
        severity: "HIGH",
        status: "OPEN",
        verificationStatus: "DETECTED",
        sourceRevision: "b".repeat(40),
        evidenceHref: "/dashboard/findings/finding-1",
        retestState: "unsupported",
        proposalState: "stale",
      },
    ],
    truncated: false,
  },
  coverage: {
    completed: ["sast"],
    notApplicable: [],
    incomplete: ["sca"],
    manifestChecksum: "c".repeat(64),
  },
}

describe("ReleasePacketView", () => {
  it("keeps historical evidence and unavailable signatures explicit", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView payload={payload} workspaceId="ws-1" reportId="packet-report-1" />
    )
    expect(html).toContain("Not enough evidence")
    expect(html).toContain("Historical")
    expect(html).toContain("Signature unavailable")
    expect(html).toContain("verification key unavailable")
    expect(html).not.toContain("Signature valid")
  })

  it("renders remediation trust states and private export controls", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView payload={payload} workspaceId="ws-1" reportId="packet-report-1" />
    )
    expect(html).toContain("Potential tenant escape")
    expect(html).toContain("Unsupported")
    expect(html).toContain("Stale")
    expect(html).toContain("Download CSV")
    expect(html).toContain("Print / Save as PDF")
    expect(html).toContain(`/api/reports/release-packet/packet-report-1/download?workspaceId=ws-1`)
  })
})
