import { resolveOAuthReadScope } from "../../../../../../../../packages/auth/src/oauth-read-scope"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  resolveReportDelegationTarget,
  getShareableReport,
  getLaunchReportDetail,
  generateLaunchReportHTML,
  isLaunchReportShareablePayload,
  generateReportHTML,
  gatherReportData,
  isReportData,
  reportSnapshotScanBindingMatches,
  findFirst,
  update,
} = vi.hoisted(() => ({
  resolveReportDelegationTarget: vi.fn(),
  getShareableReport: vi.fn(),
  getLaunchReportDetail: vi.fn(),
  generateLaunchReportHTML: vi.fn(() => "<html>launch</html>"),
  isLaunchReportShareablePayload: vi.fn((value: unknown) => value !== null && value !== undefined),
  generateReportHTML: vi.fn(() => "<html>standard</html>"),
  gatherReportData: vi.fn(),
  isReportData: vi.fn((value: unknown) => value !== null && value !== undefined),
  reportSnapshotScanBindingMatches: vi.fn(
    (contentJson: unknown, scanId: string | null, type: string) => {
      if (type === "launch_readiness") return true
      if (contentJson === null || contentJson === undefined) return true
      if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson))
        return false
      if (!Object.hasOwn(contentJson, "scanInfo")) return true
      const scanInfo = (contentJson as Record<string, unknown>).scanInfo
      if (scanInfo === null) return scanId === null
      if (!scanInfo || typeof scanInfo !== "object" || Array.isArray(scanInfo)) return false
      return (
        typeof (scanInfo as Record<string, unknown>).scanId === "string" &&
        (scanInfo as Record<string, unknown>).scanId === scanId
      )
    }
  ),
  findFirst: vi.fn(),
  update: vi.fn(),
}))
const resolveDelegatedTargetReadScope = vi.hoisted(() => vi.fn())
const withDelegatedReadAuthority = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/db", () => ({
  resolveReportDelegationTarget,
  getShareableReport,
  getLaunchReportDetail,
  generateLaunchReportHTML,
  isLaunchReportShareablePayload,
  generateReportHTML,
  gatherReportData,
  isReportData,
  reportSnapshotScanBindingMatches,
  withDelegatedReadAuthority,
  prisma: { report: { findFirst, update } },
}))
vi.mock("@lyrashield/auth/server", () => ({
  resolveOAuthReadScope,
  assertOAuthDelegatedScope: (
    session: {
      oauth?: { connectionId?: string; allTargets?: boolean; allowedTargetIds?: string[] }
    },
    targetId: string | null | undefined
  ) => {
    const connection = session.oauth
    if (!connection?.connectionId) return
    if (!targetId && !connection.allTargets) throw new Error("FORBIDDEN")
    if (targetId && !connection.allTargets && !connection.allowedTargetIds?.includes(targetId)) {
      throw new Error("FORBIDDEN")
    }
  },
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))
vi.mock("../../../../../lib/delegated-target-read-scope", () => ({
  resolveDelegatedTargetReadScope,
  delegatedReadPrincipal: (session: {
    oauth?: {
      connectionId?: string
      allTargets?: boolean
      allowedTargetIds?: string[]
    }
  }) =>
    session.oauth?.connectionId
      ? {
          workspaceId: "ws-1",
          userId: "user-1",
          memberId: "member-1",
          memberRole: "OWNER",
          memberUpdatedAt: new Date("2026-11-05T10:00:00Z"),
          connectionId: session.oauth.connectionId,
          authorizationVersion: 2,
          allTargets: session.oauth.allTargets,
          allowedTargetIds: session.oauth.allowedTargetIds ?? [],
        }
      : null,
}))

import { GET } from "./route"
import { requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

function installDelegatedAuthorityMock() {
  withDelegatedReadAuthority.mockImplementation(async (params, run) => {
    const principal = params as { allTargets?: boolean; allowedTargetIds?: string[] }
    return run(
      { report: { findFirst, update } },
      {
        targetIds: principal.allTargets
          ? ["target-1", "target-a", "target-b"]
          : (principal.allowedTargetIds ?? []),
        allowedProfiles: ["STANDARD"],
      }
    )
  })
}

describe("GET /api/reports/[id]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveDelegatedTargetReadScope.mockImplementation((session, _workspace, targetId) =>
      Promise.resolve(resolveOAuthReadScope(session as never, targetId as never, true))
    )
    installDelegatedAuthorityMock()
    getShareableReport.mockResolvedValue({ id: "report-1" })
    getLaunchReportDetail.mockResolvedValue({ stale: false })
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
    expect(generateLaunchReportHTML).toHaveBeenCalledWith(payload, { historical: false })
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

  it("renders a retained inconsistent report as historical without changing its signed snapshot", async () => {
    const payload = { verdictLabel: "Ready to launch", stale: false, reportChecksum: "signed" }
    getLaunchReportDetail.mockResolvedValue({ stale: true })
    findFirst.mockResolvedValue({
      contentJson: payload,
      scanId: null,
      title: "Report",
      type: "launch_readiness",
    })
    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(response.status).toBe(200)
    expect(generateLaunchReportHTML).toHaveBeenCalledWith(payload, { historical: true })
    expect(payload.stale).toBe(false)
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

it("denies a read-only ungranted report before download/conditional response", async () => {
  vi.clearAllMocks()
  installDelegatedAuthorityMock()
  vi.mocked(requirePermission).mockResolvedValueOnce({
    session: {
      oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: ["target-1"] },
    },
  } as never)
  resolveReportDelegationTarget.mockResolvedValueOnce({ targetId: "target-2" })
  isLaunchReportShareablePayload.mockReturnValue(true)
  getShareableReport.mockReset().mockResolvedValueOnce({ id: "report-2", title: "Private report" })
  findFirst.mockReset().mockResolvedValueOnce({
    title: "Private report",
    type: "launch_readiness",
    contentJson: {},
    scanId: null,
  })
  update.mockReset().mockResolvedValueOnce({})
  const response = await GET(
    new Request("http://localhost/api/reports/report-2/download?workspaceId=ws-1", {
      headers: { "If-None-Match": '"cached"' },
    }),
    { params: Promise.resolve({ id: "report-2" }) }
  )
  expect(response.status).toBe(403)
  expect(getShareableReport).not.toHaveBeenCalled()
  expect(findFirst).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it.each([
  {
    name: "allowed selected",
    oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: ["target-1"] },
  },
  { name: "all-target", oauth: { connectionId: "conn-1", allTargets: true, allowedTargetIds: [] } },
])("allows immutable report download for $name grants", async ({ oauth }) => {
  vi.clearAllMocks()
  installDelegatedAuthorityMock()
  vi.mocked(requirePermission).mockResolvedValueOnce({ session: { oauth } } as never)
  resolveReportDelegationTarget.mockReset().mockResolvedValue({ targetId: "target-1" })
  getShareableReport.mockReset().mockResolvedValueOnce({ id: "report-1", title: "Private report" })
  findFirst.mockReset().mockResolvedValueOnce({
    title: "Private report",
    type: "launch_readiness",
    contentJson: {},
    scanId: null,
  })
  update.mockReset().mockResolvedValueOnce({})
  isLaunchReportShareablePayload.mockReturnValue(true)
  const response = await GET(
    new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
    { params: Promise.resolve({ id: "report-1" }) }
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/)
  expect(resolveReportDelegationTarget).toHaveBeenCalled()
})

it.each([null, { targetId: null }])(
  "keeps missing/unbound reports unavailable to selected grants %j",
  async (binding) => {
    vi.clearAllMocks()
    installDelegatedAuthorityMock()
    vi.mocked(requirePermission).mockResolvedValueOnce({
      session: { oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: [] } },
    } as never)
    resolveReportDelegationTarget.mockReset().mockResolvedValueOnce(binding)
    const response = await GET(
      new Request("http://localhost/api/reports/report-1/download?workspaceId=ws-1"),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(response.status).toBe(binding ? 403 : 404)
    expect(getShareableReport).not.toHaveBeenCalled()
  }
)
