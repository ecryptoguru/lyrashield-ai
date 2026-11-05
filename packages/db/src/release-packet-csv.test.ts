import { describe, expect, it } from "vitest"
import type { ReleasePacketPayload } from "@lyrashield/types"
import { escapeReleasePacketCsvCell, generateReleasePacketCsv } from "./release-packet-csv"

const payload: ReleasePacketPayload = {
  version: "release_packet/1.0.0",
  packetChecksum: "a".repeat(64),
  generatedAt: "2026-11-05T00:00:00.000Z",
  target: {
    id: "target-1",
    name: '=HYPERLINK("https://evil")',
    type: "REPO",
    environment: "PRODUCTION",
  },
  assessment: {
    verdictId: "verdict-1",
    standardVersion: "lyrashield-gate/2.4.0",
    state: "READY",
    historicalState: "READY",
    applicable: true,
    reasons: [],
    evaluatedAt: "2026-11-05T00:00:00.000Z",
    assessedIdentity: { kind: "COMMIT", value: "b".repeat(40) },
    coverageStatement: ["sast"],
    nonCoverage: [],
  },
  signedAssessment: { state: "UNSIGNED", reason: "No signing key" },
  remediation: {
    baselineScanId: null,
    currentScanId: "scan-1",
    counts: { newFindings: 1, recurringFindings: 0, resolvedFindings: 0, uncertainMatches: 0 },
    findings: [
      {
        category: "new",
        findingId: "finding-1",
        dedupeKey: "d-1",
        title: "+cmd|' /C calc'!A0",
        severity: "HIGH",
        status: "OPEN",
        verificationStatus: "DETECTED",
        sourceRevision: "b".repeat(40),
        evidenceHref: "/dashboard/findings/finding-1",
        retestState: "none",
        proposalState: "none",
      },
    ],
    truncated: false,
  },
  coverage: {
    completed: ["sast"],
    notApplicable: [],
    incomplete: [],
    manifestChecksum: "c".repeat(64),
  },
}

describe("release packet CSV", () => {
  it("neutralizes spreadsheet formula prefixes without losing user data", () => {
    expect(escapeReleasePacketCsvCell("=1+1")).toBe('"\'=1+1"')
    expect(escapeReleasePacketCsvCell("+cmd")).toBe('"\'+cmd"')
    expect(escapeReleasePacketCsvCell('quoted "value"')).toBe('"quoted ""value"""')
  })

  it("contains scope, integrity and finding rows with neutralized cells", () => {
    const csv = generateReleasePacketCsv(payload)
    expect(csv).toContain('"scope","packetChecksum","aaaaaaaa')
    expect(csv).toContain('"target","name","\'=HYPERLINK')
    expect(csv).toContain('"finding","finding-1","\'+cmd')
    expect(csv).not.toContain("encrypted://")
  })
})
