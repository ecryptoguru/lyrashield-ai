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
  const result = {
    payload,
    authenticity: {
      signatureState: "HISTORICAL_UNSIGNED" as const,
      expiresAt: null,
      expired: null,
      checkedAt: "2026-11-06T00:00:00.000Z",
    },
    assessmentValidity: { signatureState: "UNAVAILABLE" as const, expiresAt: null, expired: null },
    currentApplicability: { state: "NOT_CURRENT" as const, reasons: [] },
  }
  it("keeps historical evidence and unavailable signatures explicit", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView result={result} workspaceId="ws-1" reportId="packet-report-1" />
    )
    expect(html).toContain("Not enough evidence")
    expect(html).toContain("Historical")
    expect(html).toContain("Assessment signature unavailable")
    expect(html).toContain("Historical unsigned packet")
    expect(html).toContain("This historical packet has a checksum but no packet signature")
    expect(html).toContain("verification key unavailable")
    expect(html).not.toContain("Signature valid")
  })

  it("renders remediation trust states and private export controls", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView result={result} workspaceId="ws-1" reportId="packet-report-1" />
    )
    expect(html).toContain("Potential tenant escape")
    expect(html).toContain("Unsupported")
    expect(html).toContain("Stale")
    expect(html).toContain("Download CSV")
    expect(html).toContain("Print / Save as PDF")
    expect(html).toContain(`/api/reports/release-packet/packet-report-1/download?workspaceId=ws-1`)
  })

  it("marks invalid packet signatures and hides export controls", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView
        result={{ ...result, authenticity: { ...result.authenticity, signatureState: "INVALID" } }}
        workspaceId="ws-1"
        reportId="packet-report-1"
      />
    )
    expect(html).toContain("Packet signature invalid")
    expect(html).not.toContain("Download CSV")
    expect(html).not.toContain("Print / Save as PDF")
  })

  it("renders a workspace packet without a second main landmark or a token requirement", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView
        result={result}
        workspaceId="ws-1"
        reportId="packet-report-1"
        workspaceView
      />
    )
    expect(html).not.toContain("<main")
    expect(html).toContain("Access requires workspace report permission")
    expect(html).toContain("Download CSV")
    expect(html).toContain("Historical — not current evidence")
  })

  it("describes the packet signature separately for version 1.1", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView
        result={{
          ...result,
          payload: {
            ...payload,
            version: "release_packet/1.1.0",
            signingKeyId: "packet-key-id",
            packetSignature: "packet-signature",
            expiresAt: "2026-11-06T06:00:00.000Z",
          },
        }}
        workspaceId="ws-1"
        reportId="packet-report-1"
      />
    )
    expect(html).toContain("The packet signature authenticates the checksum")
    expect(html).toContain("packet-key-id")
    expect(html).toContain("packet-signature")
    expect(html).not.toContain("no packet signature")
  })

  it("keeps an assessment marked historical even if signatures and current applicability pass", () => {
    const html = renderToStaticMarkup(
      <ReleasePacketView
        result={{
          payload: { ...payload, signedAssessment: { state: "HISTORICAL" } },
          authenticity: { ...result.authenticity, signatureState: "VERIFIED", expired: false },
          assessmentValidity: { signatureState: "VERIFIED", expiresAt: null, expired: false },
          currentApplicability: { state: "CURRENT", reasons: [] },
        }}
        workspaceId="ws-1"
        reportId="packet-report-1"
      />
    )
    expect(html).toContain("Historical — not current evidence")
  })
})
