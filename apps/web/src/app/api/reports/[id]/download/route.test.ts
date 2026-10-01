import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getShareableReport,
  generateLaunchReportHTML,
  isLaunchReportShareablePayload,
  generateReportHTML,
  gatherReportData,
  isReportData,
  findFirst,
  update,
} = vi.hoisted(() => ({
  getShareableReport: vi.fn(),
  generateLaunchReportHTML: vi.fn(() => "<html>launch</html>"),
  isLaunchReportShareablePayload: vi.fn((value: unknown) => value !== null && value !== undefined),
  generateReportHTML: vi.fn(() => "<html>standard</html>"),
  gatherReportData: vi.fn(),
  isReportData: vi.fn((value: unknown) => value !== null && value !== undefined),
  findFirst: vi.fn(),
  update: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getShareableReport,
  generateLaunchReportHTML,
  isLaunchReportShareablePayload,
  generateReportHTML,
  gatherReportData,
  isReportData,
  prisma: { report: { findFirst, update } },
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn().mockResolvedValue({}) }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { GET } from "./route"
import { requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

describe("GET /api/reports/[id]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getShareableReport.mockResolvedValue({ id: "report-1" })
    update.mockResolvedValue({})
  })

  it("renders launch reports with their allowlisted renderer", async () => {
    const payload = { verdictLabel: "Ready to launch" }
    findFirst.mockResolvedValue({
      contentJson: payload,
      scanId: null,
      title: "Launch: Readiness?",
      type: "launch_readiness",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<html>launch</html>")
    expect(generateLaunchReportHTML).toHaveBeenCalledWith(payload)
    expect(generateReportHTML).not.toHaveBeenCalled()
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "report:download")
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="Launch Readiness.html"'
    )
  })

  it("denies report downloads when report:download is missing", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/reports/[id]/download",
      "GET"
    )
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("returns an attachment with a server-sanitized title when requested", async () => {
    findFirst.mockResolvedValue({
      contentJson: { findings: [], scanInfo: { scanId: "scan-1" } },
      scanId: "scan-1",
      title: "Security / Review",
      type: "executive",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1&download=1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(await response.text()).toBe("<html>standard</html>")
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Security  Review.html"'
    )
  })

  it("does not replace a present invalid snapshot with newly generated report data", async () => {
    isReportData.mockReturnValueOnce(false)
    findFirst.mockResolvedValue({
      contentJson: { findings: "malformed" },
      scanId: "scan-1",
      title: "Legacy report",
      type: "developer",
    })
    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(409)
    expect(gatherReportData).not.toHaveBeenCalled()
    expect(generateReportHTML).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("renders scanless workspace report snapshots", async () => {
    const snapshot = { findings: [], scanInfo: null }
    findFirst.mockResolvedValue({
      contentJson: snapshot,
      scanId: null,
      title: "Workspace report",
      type: "executive",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(200)
    expect(generateReportHTML).toHaveBeenCalledWith(snapshot)
    expect(gatherReportData).not.toHaveBeenCalled()
  })

  it("rejects a valid snapshot bound to a different source scan", async () => {
    const snapshot = { findings: [], scanInfo: { scanId: "scan-2" } }
    findFirst.mockResolvedValue({
      contentJson: snapshot,
      scanId: "scan-1",
      title: "Mismatched report",
      type: "developer",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(409)
    expect(generateReportHTML).not.toHaveBeenCalled()
    expect(gatherReportData).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("regenerates a legacy report only when its snapshot is absent", async () => {
    const regenerated = { findings: [], scanInfo: { scanId: "scan-1" }, title: "Legacy report" }
    findFirst.mockResolvedValue({
      contentJson: null,
      scanId: "scan-1",
      title: "Legacy report",
      type: "developer",
    })
    gatherReportData.mockResolvedValueOnce(regenerated)

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(200)
    expect(gatherReportData).toHaveBeenCalledWith("ws-1", "scan-1")
    expect(generateReportHTML).toHaveBeenCalledWith(regenerated)
  })

  it("returns 409 when regenerated data does not match the report source scan", async () => {
    isReportData.mockReturnValueOnce(false)
    findFirst.mockResolvedValue({
      contentJson: { findings: "malformed" },
      scanId: "scan-1",
      title: "Legacy report",
      type: "developer",
    })
    gatherReportData.mockResolvedValueOnce({ scanInfo: { scanId: "scan-2" } })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(409)
    expect(generateReportHTML).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("returns 409 for an invalid snapshot without a source scan", async () => {
    isReportData.mockReturnValueOnce(false)
    findFirst.mockResolvedValue({
      contentJson: { findings: "malformed" },
      scanId: null,
      title: "Legacy report",
      type: "developer",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(409)
    expect(generateReportHTML).not.toHaveBeenCalled()
    expect(gatherReportData).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("rejects a malformed launch snapshot before rendering", async () => {
    isLaunchReportShareablePayload.mockReturnValueOnce(false)
    findFirst.mockResolvedValue({
      contentJson: { counts: {} },
      scanId: null,
      title: "Launch Readiness",
      type: "launch_readiness",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(409)
    expect(generateLaunchReportHTML).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("does not reconstruct a missing launch snapshot from live scan state", async () => {
    findFirst.mockResolvedValue({
      contentJson: null,
      scanId: "scan-1",
      title: "Launch Readiness",
      type: "launch_readiness",
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(409)
    expect(gatherReportData).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("does not mark a report downloaded when rendering fails", async () => {
    findFirst.mockResolvedValue({
      contentJson: { verdictLabel: "Ready to launch" },
      scanId: null,
      title: "Launch Readiness",
      type: "launch_readiness",
    })
    generateLaunchReportHTML.mockImplementationOnce(() => {
      throw new Error("render failed")
    })

    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(500)
    expect(update).not.toHaveBeenCalled()
  })

  it("returns an ETag on 200 and a bodyless 304 for a matching If-None-Match (W2.4)", async () => {
    findFirst.mockResolvedValue({
      contentJson: { verdictLabel: "Ready to launch" },
      scanId: null,
      title: "Launch Readiness",
      type: "launch_readiness",
    })

    const first = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(first.status).toBe(200)
    const etag = first.headers.get("ETag")
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    const second = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1", {
        headers: { "If-None-Match": etag! },
      }),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(second.status).toBe(304)
    expect(second.headers.get("ETag")).toBe(etag)
    expect(await second.text()).toBe("")
  })
})
