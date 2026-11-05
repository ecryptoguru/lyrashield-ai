import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getReleasePacket: vi.fn(),
  generateCsv: vi.fn(() => '"target","name","\'=formula"\r\n'),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/db", () => ({
  getReleasePacket: mocks.getReleasePacket,
  generateReleasePacketCsv: mocks.generateCsv,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("GET release packet CSV", () => {
  it("serves an authenticated CSV with formula-safe cells", async () => {
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.getReleasePacket.mockResolvedValue({
      version: "release_packet/1.0.0",
      packetChecksum: "a".repeat(64),
      generatedAt: "2026-11-05T00:00:00.000Z",
      target: { id: "target-1", name: "=formula", type: "REPO", environment: "PRODUCTION" },
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
      signedAssessment: { state: "UNSIGNED" },
      remediation: {
        baselineScanId: null,
        currentScanId: "scan-1",
        counts: { newFindings: 0, recurringFindings: 0, resolvedFindings: 0, uncertainMatches: 0 },
        findings: [],
        truncated: false,
      },
      coverage: { completed: ["sast"], notApplicable: [], incomplete: [], manifestChecksum: null },
    })

    const response = await GET(
      new Request("http://localhost/api/reports/release-packet/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    const csv = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/csv")
    expect(response.headers.get("Content-Disposition")).toContain("release-packet-report-1.csv")
    expect(csv).toContain('"\'=formula"')
    expect(mocks.getReleasePacket).toHaveBeenCalledWith("report-1", "ws-1")
  })
})
