import { resolveOAuthReadScope } from "../../../../../../packages/auth/src/oauth-read-scope"
import { GET as V1GET } from "../v1/reports/route"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: { scan: { findFirst: vi.fn() } },
  listReports: vi.fn(),
  createReport: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  resolveOAuthReadScope,
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { report: { create: "report:create", download: "report:download" } },
}))

vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))
vi.mock("../../../lib/cache", () => ({ revalidateDashboardAggregates: vi.fn() }))

import { GET, POST } from "./route"
import { prisma, createReport, listReports } from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

describe("POST /api/reports", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user-1" } } as never)
  })

  it("rejects a scan that does not belong to the requested workspace", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null as never)

    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          scanId: "scan-other-workspace",
          title: "Report",
        }),
      })
    )

    expect(await response.json()).toMatchObject({ error: { code: "SCAN_NOT_FOUND" } })
    expect(response.status).toBe(404)
    expect(createReport).not.toHaveBeenCalled()
  })

  it("resolves a target-scoped report to its latest completed scan", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue({ id: "scan-latest" } as never)
    vi.mocked(createReport).mockResolvedValue({
      id: "report-1",
      title: "Report",
      status: "generated",
    } as never)

    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          title: "Report",
        }),
      })
    )

    expect(prisma.scan.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        targetId: "target-1",
        status: "COMPLETED",
        deletedAt: null,
      },
      orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    })
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", scanId: "scan-latest" })
    )
    expect(assertOAuthDelegatedScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "target-1"
    )
    expect(response.status).toBe(201)
  })

  it("reports immutable snapshot reuse without claiming a new report was created", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue({ id: "scan-latest" } as never)
    vi.mocked(createReport).mockResolvedValue({
      id: "report-existing",
      title: "Original snapshot",
      status: "generated",
      snapshotReused: true,
    } as never)

    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          title: "Requested title",
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        id: "report-existing",
        title: "Original snapshot",
        requestedTitle: "Requested title",
        snapshotReused: true,
      },
    })
  })

  it("denies report listing without report:download", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)
    const response = await GET(new Request("http://localhost/api/reports?workspaceId=ws-1"))
    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/reports",
      "GET"
    )
    expect(listReports).not.toHaveBeenCalled()
  })

  it("denies report creation without report:create", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error("FORBIDDEN") as never)
    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1", title: "Report" }),
      })
    )
    expectPermissionDenied(
      response,
      vi.mocked(requirePermission).mock.calls,
      "ws-1",
      "/api/reports",
      "POST"
    )
    expect(createReport).not.toHaveBeenCalled()
  })
})

describe("GET /api/reports — conditional GET (W2.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user-1" } } as never)
    vi.mocked(listReports).mockResolvedValue({
      items: [{ id: "report-1", title: "Report" }],
      nextCursor: null,
    } as never)
  })

  it("returns an ETag on 200 and a bodyless 304 for a matching If-None-Match", async () => {
    const first = await GET(new Request("http://localhost/api/reports?workspaceId=ws-1"))
    expect(first.status).toBe(200)
    const etag = first.headers.get("ETag")
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    const second = await GET(
      new Request("http://localhost/api/reports?workspaceId=ws-1", {
        headers: { "If-None-Match": etag! },
      })
    )
    expect(second.status).toBe(304)
    expect(second.headers.get("ETag")).toBe(etag)
    expect(await second.text()).toBe("")
  })

  it("serves a fresh representation when the list changed", async () => {
    const first = await GET(new Request("http://localhost/api/reports?workspaceId=ws-1"))
    const etag = first.headers.get("ETag")

    vi.mocked(listReports).mockResolvedValue({
      items: [{ id: "report-2", title: "Report" }],
      nextCursor: null,
    } as never)

    const second = await GET(
      new Request("http://localhost/api/reports?workspaceId=ws-1", {
        headers: { "If-None-Match": etag! },
      })
    )
    expect(second.status).toBe(200)
    expect(second.headers.get("ETag")).not.toBe(etag)
  })
})

it.each([{ targetIds: ["target-1"] }, { targetIds: [] }])(
  "bounds omitted target reads and pagination to $targetIds",
  async ({ targetIds }) => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValueOnce({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          scopes: ["lyrashield.read"],
          allTargets: false,
          allowedTargetIds: targetIds,
        },
      },
    } as never)
    vi.mocked(listReports).mockResolvedValueOnce({ items: [], nextCursor: null })
    const response = await (targetIds.length ? GET : V1GET)(
      new Request("http://localhost/api/reports?workspaceId=ws-1&cursor=cursor-1")
    )
    expect(response.status).toBe(200)
    expect(listReports).toHaveBeenCalledWith("ws-1", "cursor-1", 50, targetIds)
  }
)

it("does not return a broad cached report page after a target grant narrows", async () => {
  vi.clearAllMocks()
  vi.mocked(requirePermission).mockResolvedValueOnce({
    session: { oauth: { connectionId: "conn-1", allTargets: true } },
  } as never)
  vi.mocked(listReports).mockResolvedValueOnce({
    items: [{ id: "workspace-report" }],
    nextCursor: null,
  } as never)
  const url = "http://localhost/api/reports?workspaceId=ws-1"
  const first = await GET(new Request(url))
  expect(first.status).toBe(200)
  vi.mocked(requirePermission).mockResolvedValueOnce({
    session: { oauth: { connectionId: "conn-1", allTargets: false, allowedTargetIds: [] } },
  } as never)
  vi.mocked(listReports).mockResolvedValueOnce({ items: [], nextCursor: null })
  const response = await GET(
    new Request(url, { headers: { "If-None-Match": first.headers.get("ETag")! } })
  )
  expect(response.status).toBe(200)
  expect((await response.json()).data).toEqual({ items: [], nextCursor: null })
  expect(listReports).toHaveBeenLastCalledWith("ws-1", undefined, 50, [])
})

it("preserves omitted-target all-target delegation reads", async () => {
  vi.clearAllMocks()
  vi.mocked(requirePermission).mockResolvedValueOnce({
    session: { oauth: { connectionId: "conn-1", allTargets: true, allowedTargetIds: [] } },
  } as never)
  vi.mocked(listReports).mockResolvedValueOnce({ items: [], nextCursor: null })
  const response = await V1GET(new Request("http://localhost/api/reports?workspaceId=ws-1"))
  expect(response.status).toBe(200)
  expect(listReports).toHaveBeenLastCalledWith("ws-1", undefined, 50, undefined)
})
