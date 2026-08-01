import { describe, expect, it, vi } from "vitest"

const getReportByShareToken = vi.fn()
const getShareableReport = vi.fn()

vi.mock("@lyrashield/db", () => ({ getReportByShareToken, getShareableReport }))

const { GET } = await import("./route")

function request(id: string, token?: string) {
  const url = new URL(`http://localhost:3000/api/reports/shared/${id}`)
  if (token) url.searchParams.set("token", token)
  return new Request(url)
}

describe("GET /api/reports/shared/[id]", () => {
  it("rejects a request without a token", async () => {
    const response = await GET(request("report-1"), { params: Promise.resolve({ id: "report-1" }) })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: "MISSING_PARAM" } })
  })

  it("rejects a malformed share token before querying the database", async () => {
    getReportByShareToken.mockResolvedValue(null)
    const response = await GET(
      request("report-1", "not-a-valid-token"),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "REPORT_NOT_FOUND" },
    })
    expect(getReportByShareToken).toHaveBeenCalledWith("not-a-valid-token")
  })

  it("rejects a token that does not match the requested report id", async () => {
    getReportByShareToken.mockResolvedValue({
      id: "report-other",
      workspaceId: "ws-1",
      shareExpiresAt: null,
    })

    const response = await GET(
      request("report-1", "a".repeat(64)),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(404)
    expect(getShareableReport).not.toHaveBeenCalled()
  })

  it("returns the shareable report when the token and id match", async () => {
    getReportByShareToken.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: null,
    })
    getShareableReport.mockResolvedValue({
      id: "report-1",
      title: "Assurance report",
      type: "developer",
      status: "generated",
      format: "html",
      shareUrl: null,
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    })

    const response = await GET(
      request("report-1", "b".repeat(64)),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true })
    expect(getShareableReport).toHaveBeenCalledWith("report-1", "ws-1")
  })

  it("returns a 500 when the share lookup throws", async () => {
    getReportByShareToken.mockRejectedValue(new Error("db down"))

    const response = await GET(
      request("report-1", "c".repeat(64)),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "INTERNAL_ERROR" },
    })
  })
})
