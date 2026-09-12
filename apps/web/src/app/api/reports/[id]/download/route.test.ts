import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getShareableReport,
  generateLaunchReportHTML,
  generateReportHTML,
  gatherReportData,
  findFirst,
  update,
} = vi.hoisted(() => ({
  getShareableReport: vi.fn(),
  generateLaunchReportHTML: vi.fn(() => "<html>launch</html>"),
  generateReportHTML: vi.fn(() => "<html>standard</html>"),
  gatherReportData: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getShareableReport,
  generateLaunchReportHTML,
  generateReportHTML,
  gatherReportData,
  prisma: { report: { findFirst, update } },
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn().mockResolvedValue({}) }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { GET } from "./route"

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
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="Launch Readiness.html"'
    )
  })

  it("returns an attachment with a server-sanitized title when requested", async () => {
    findFirst.mockResolvedValue({
      contentJson: { findings: [] },
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
})
