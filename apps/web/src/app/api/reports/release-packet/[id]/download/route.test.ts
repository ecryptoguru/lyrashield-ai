import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getReleasePacket: vi.fn(),
  getReleasePacketForDelegatedRead: vi.fn(),
  generateCsv: vi.fn(() => '"target","name","\'=formula"\r\n'),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/db", () => ({
  getReleasePacket: mocks.getReleasePacket,
  getReleasePacketForDelegatedRead: mocks.getReleasePacketForDelegatedRead,
  generateReleasePacketCsv: mocks.generateCsv,
  ReleasePacketError: class ReleasePacketError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("@lyrashield/billing", () => ({
  resolveReleasePacketVerificationKeys: vi.fn().mockResolvedValue([]),
  resolveLaunchReportSigningPublicKey: vi.fn().mockResolvedValue(null),
}))

import { GET } from "./route"

const payload = {
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
}
const verification = { verificationKeys: [], assessmentPublicKey: null }
const packetResult = {
  payload,
  authenticity: { signatureState: "HISTORICAL_UNSIGNED" },
  assessmentValidity: {},
  currentApplicability: {},
}

function request() {
  return new Request(
    "http://localhost/api/reports/release-packet/report-1/download?workspaceId=ws-1"
  )
}

describe("GET release packet CSV", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
  })

  it("serves an authenticated CSV with formula-safe cells", async () => {
    mocks.getReleasePacket.mockResolvedValue(packetResult)

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })
    const csv = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/csv")
    expect(response.headers.get("Content-Disposition")).toContain("release-packet-report-1.csv")
    expect(csv).toContain('"\'=formula"')
    expect(mocks.getReleasePacket).toHaveBeenCalledWith("report-1", "ws-1", verification)
    expect(mocks.generateCsv).toHaveBeenCalledWith(payload, packetResult)
    expect(mocks.getReleasePacketForDelegatedRead).not.toHaveBeenCalled()
  })

  it("reads an OAuth-delegated packet under the live connection authority", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          authorizationVersion: 3,
          workspaceId: "ws-1",
          allTargets: false,
          allowedTargetIds: ["target-1"],
        },
      },
    })
    mocks.getReleasePacketForDelegatedRead.mockResolvedValue(packetResult)

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    expect(mocks.getReleasePacketForDelegatedRead).toHaveBeenCalledWith({
      reportId: "report-1",
      workspaceId: "ws-1",
      userId: "user-1",
      connectionId: "conn-1",
      authorizationVersion: 3,
      ...verification,
    })
    expect(mocks.getReleasePacket).not.toHaveBeenCalled()
  })

  it("refuses CSV export when a packet signature is revoked", async () => {
    mocks.getReleasePacket.mockResolvedValue({
      ...packetResult,
      authenticity: { signatureState: "REVOKED" },
    })
    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })
    expect(response.status).toBe(409)
    expect(mocks.generateCsv).not.toHaveBeenCalled()
  })

  it("returns a non-disclosing 404 when delegated authority or binding fails", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          authorizationVersion: 3,
          workspaceId: "ws-1",
          allTargets: false,
          allowedTargetIds: ["target-1"],
        },
      },
    })
    mocks.getReleasePacketForDelegatedRead.mockResolvedValue(null)

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(404)
    expect(mocks.getReleasePacket).not.toHaveBeenCalled()
  })

  it("fails closed when a delegated session has no authorization version", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: { connectionId: "conn-1", workspaceId: "ws-1", allTargets: true },
      },
    })

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(403)
    expect(mocks.getReleasePacket).not.toHaveBeenCalled()
    expect(mocks.getReleasePacketForDelegatedRead).not.toHaveBeenCalled()
  })

  it("maps an invalid stored snapshot to a distinct conflict", async () => {
    const { ReleasePacketError } = await import("@lyrashield/db")
    mocks.getReleasePacket.mockRejectedValue(
      new ReleasePacketError("SNAPSHOT_INVALID", "checksum mismatch")
    )

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "REPORT_SNAPSHOT_MISSING" },
    })
  })
})
