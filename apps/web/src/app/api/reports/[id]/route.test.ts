import { beforeEach, describe, expect, it, vi } from "vitest"

const generateShareToken = vi.fn()
const revokeShareToken = vi.fn()
const getShareableReport = vi.fn()
const getLaunchReportDetail = vi.fn()

vi.mock("@lyrashield/db", () => ({
  generateShareToken: (...args: unknown[]) => generateShareToken(...args),
  revokeShareToken: (...args: unknown[]) => revokeShareToken(...args),
  getShareableReport: (...args: unknown[]) => getShareableReport(...args),
  getLaunchReportDetail: (...args: unknown[]) => getLaunchReportDetail(...args),
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { role: "OWNER", member: {} },
  }),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, POST } from "./route"

function actionRequest(body: unknown) {
  return new Request("http://localhost/api/reports/report-1", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/reports/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getShareableReport.mockResolvedValue({ id: "report-1", status: "generated" })
  })

  describe("action: share", () => {
    it("returns the share payload WITHOUT tokenHash", async () => {
      generateShareToken.mockResolvedValue({
        token: "a".repeat(64),
        tokenHash: "b".repeat(64),
        expiresAt: new Date("2026-09-15T00:00:00Z"),
      })

      const response = await POST(actionRequest({ workspaceId: "ws-1", action: "share" }), {
        params: Promise.resolve({ id: "report-1" }),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      // The client has no legitimate use for a hash of the bearer token it already
      // holds — pin the exact key set so the hash cannot silently return.
      expect(Object.keys(body.data).sort()).toEqual(["expiresAt", "shareUrl", "token"])
      expect(body.data.token).toBe("a".repeat(64))
      expect(body.data.shareUrl).toBe(`/reports/shared/report-1?token=${"a".repeat(64)}`)
      expect(JSON.stringify(body)).not.toContain("tokenHash")
    })

    it("404s when the report does not exist in the workspace", async () => {
      getShareableReport.mockResolvedValue(null)

      const response = await POST(actionRequest({ workspaceId: "ws-1", action: "share" }), {
        params: Promise.resolve({ id: "report-1" }),
      })

      expect(response.status).toBe(404)
      expect(generateShareToken).not.toHaveBeenCalled()
    })
  })

  describe("action: revoke", () => {
    it("still returns the revocation timestamp", async () => {
      revokeShareToken.mockResolvedValue(new Date("2026-08-16T00:00:00Z"))

      const response = await POST(actionRequest({ workspaceId: "ws-1", action: "revoke" }), {
        params: Promise.resolve({ id: "report-1" }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: { revoked: true, revokedAt: "2026-08-16T00:00:00.000Z" },
      })
    })
  })
})

describe("GET /api/reports/[id] — authenticated private detail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getShareableReport.mockResolvedValue({ id: "report-1", status: "generated" })
  })

  const PROVENANCE = {
    schemaVersion: "lyrashield-report-provenance/1.0.0",
    gateVerdictId: "verdict-1",
    verdictChecksum: "vc-1",
    assessmentVersion: 2,
    assessedIdentity: { kind: "COMMIT", value: "b".repeat(40) },
    assessedAt: "2026-09-10T00:00:00.000Z",
    issuedAt: "2026-09-10T01:00:00.000Z",
    applicabilityCheckedAt: "2026-09-10T01:00:00.000Z",
    applicability: "applicable",
    reasonCodes: [],
    historicalState: "READY",
    effectiveState: "READY",
  }

  function getRequest() {
    return new Request("http://localhost/api/reports/report-1?workspaceId=ws-1")
  }

  it("includes private launch provenance for launch_readiness reports", async () => {
    getShareableReport.mockResolvedValue({ id: "report-1", type: "launch_readiness" })
    getLaunchReportDetail.mockResolvedValue({
      verdictLabel: "Ready to launch",
      stale: false,
      provenance: PROVENANCE,
    })

    const response = await GET(getRequest(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.launchReport.provenance.gateVerdictId).toBe("verdict-1")
    expect(body.data.launchReport.provenance.assessedIdentity.value).toBe("b".repeat(40))
    expect(getLaunchReportDetail).toHaveBeenCalledWith("report-1", "ws-1")
  })

  it("omits launch provenance for other report types", async () => {
    getShareableReport.mockResolvedValue({ id: "report-1", type: "developer" })

    const response = await GET(getRequest(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data.launchReport).toBeUndefined()
    expect(getLaunchReportDetail).not.toHaveBeenCalled()
  })
})
