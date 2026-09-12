import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getShareableReport: vi.fn(),
  generateReportHTML: vi.fn(() => "generic-html"),
  generateLaunchReportHTML: vi.fn(() => "launch-html"),
  isLaunchReportShareablePayload: vi.fn(
    (value: unknown) =>
      !!value &&
      typeof value === "object" &&
      "payloadVersion" in value &&
      typeof value.payloadVersion === "string"
  ),
  gatherReportData: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getShareableReport: mocks.getShareableReport,
  generateReportHTML: mocks.generateReportHTML,
  generateLaunchReportHTML: mocks.generateLaunchReportHTML,
  isLaunchReportShareablePayload: mocks.isLaunchReportShareablePayload,
  gatherReportData: mocks.gatherReportData,
  prisma: { report: { findFirst: mocks.findFirst, update: mocks.update } },
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
  setRequestId: vi.fn(),
}))
vi.mock("../../../../../lib/api-auth", () => ({ authErrorResponse: vi.fn(() => null) }))

import { GET } from "./route"

const request = new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1")
const context = { params: Promise.resolve({ id: "report-1" }) }

describe("GET /api/reports/[id]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.update.mockResolvedValue({})
  })

  it("renders launch snapshots with the launch renderer", async () => {
    const frozenPayload = { payloadVersion: "lyrashield-launch-report/2.0.0" }
    mocks.getShareableReport.mockResolvedValue({ id: "report-1", type: "launch_readiness" })
    mocks.findFirst.mockResolvedValue({ contentJson: frozenPayload, scanId: null })

    const response = await GET(request, context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("launch-html")
    expect(mocks.generateLaunchReportHTML).toHaveBeenCalledWith(frozenPayload)
    expect(mocks.generateReportHTML).not.toHaveBeenCalled()
    expect(mocks.gatherReportData).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "report-1" },
      data: { status: "downloaded" },
    })
    expect(response.headers.get("content-disposition")).toContain(
      "launch-readiness-report-report-1.html"
    )
  })

  it("keeps detailed report snapshots on the generic renderer", async () => {
    const frozenSnapshot = { findings: [] }
    mocks.getShareableReport.mockResolvedValue({ id: "report-1", type: "developer" })
    mocks.findFirst.mockResolvedValue({ contentJson: frozenSnapshot, scanId: "scan-1" })

    const response = await GET(request, context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("generic-html")
    expect(mocks.generateReportHTML).toHaveBeenCalledWith(frozenSnapshot)
    expect(mocks.generateLaunchReportHTML).not.toHaveBeenCalled()
  })

  it("does not reconstruct a missing launch snapshot from live scan state", async () => {
    mocks.getShareableReport.mockResolvedValue({ id: "report-1", type: "launch_readiness" })
    mocks.findFirst.mockResolvedValue({ contentJson: null, scanId: "scan-1" })

    const response = await GET(request, context)

    expect(response.status).toBe(409)
    expect(mocks.gatherReportData).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("rejects a malformed non-null launch snapshot before rendering", async () => {
    mocks.getShareableReport.mockResolvedValue({ id: "report-1", type: "launch_readiness" })
    mocks.findFirst.mockResolvedValue({ contentJson: { counts: {} }, scanId: null })

    const response = await GET(request, context)

    expect(response.status).toBe(409)
    expect(mocks.generateLaunchReportHTML).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("does not mark a report downloaded when rendering fails", async () => {
    mocks.getShareableReport.mockResolvedValue({ id: "report-1", type: "launch_readiness" })
    mocks.findFirst.mockResolvedValue({
      contentJson: { payloadVersion: "lyrashield-launch-report/2.0.0" },
      scanId: null,
    })
    mocks.generateLaunchReportHTML.mockImplementationOnce(() => {
      throw new Error("render failed")
    })

    const response = await GET(request, context)

    expect(response.status).toBe(500)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
