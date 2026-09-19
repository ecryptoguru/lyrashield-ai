import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getScanQualitySurface: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { view: "scan:view" } },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
  logger: { error: vi.fn() },
}))

import { GET } from "./route"
import { getScanQualitySurface } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"

const routeParams = { params: Promise.resolve({ id: "scan-1" }) }

function request(workspaceId?: string) {
  const url = workspaceId
    ? `http://localhost/api/scans/scan-1/quality?workspaceId=${workspaceId}`
    : "http://localhost/api/scans/scan-1/quality"
  return new Request(url)
}

describe("/api/scans/[id]/quality", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the measured quality surface for a workspace scan", async () => {
    vi.mocked(getScanQualitySurface).mockResolvedValue({
      version: "lyrashield-scan-quality/1.0.0",
      facts: {
        scanStatus: "COMPLETED",
        scanMode: "STANDARD",
        deterministicRun: false,
        durationMs: 1000,
        llmRequests: 5,
        findings: {
          total: 2,
          byVerificationStatus: { DETECTED: 1, VERIFIED: 1 },
          bySeverity: { HIGH: 2 },
          validatedCount: 0,
          verifiedCount: 1,
          nonConclusiveCount: 0,
        },
        coverage: {
          receiptsTotal: 3,
          byStatus: { COMPLETED: 3 },
          byScanner: { sast: 3 },
          engineDeclaredReceipts: 0,
          connectorReceipts: 0,
        },
        evidence: {
          manifestPresent: true,
          manifestChecksum: "abc",
          ingestionWarningCount: 0,
          attachmentCount: null,
        },
      },
      estimates: {
        assessedReceiptRatio: { kind: "heuristic", value: 1, basis: "test" },
        verifiedFindingRatio: { kind: "heuristic", value: 0.5, basis: "test" },
      },
      parity: {},
      surfaceChecksum: "deadbeef",
    } as never)

    const res = await GET(request("ws-1"), routeParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.version).toBe("lyrashield-scan-quality/1.0.0")
    expect(body.data.facts.findings.verifiedCount).toBe(1)
    expect(body.data.estimates.verifiedFindingRatio.kind).toBe("heuristic")
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:view")
    expect(getScanQualitySurface).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("rejects a missing workspaceId", async () => {
    const res = await GET(request(), routeParams)
    expect(res.status).toBe(400)
    expect(getScanQualitySurface).not.toHaveBeenCalled()
  })

  it("404s when the scan has no stored evidence in this workspace", async () => {
    vi.mocked(getScanQualitySurface).mockResolvedValue(null)
    const res = await GET(request("ws-1"), routeParams)
    expect(res.status).toBe(404)
  })

  it("fails closed on auth errors", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("forbidden"))
    const res = await GET(request("ws-1"), routeParams)
    expect([401, 403, 500]).toContain(res.status)
    expect(getScanQualitySurface).not.toHaveBeenCalled()
  })
})
