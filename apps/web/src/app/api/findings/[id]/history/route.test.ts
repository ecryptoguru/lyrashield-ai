import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getFindingHistoryPage: vi.fn(),
  validateFindingScope: vi.fn(),
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/db", () => ({
  getFindingHistoryPage: mocks.getFindingHistoryPage,
  validateFindingScope: mocks.validateFindingScope,
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { GET } from "./route"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

describe("finding history route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.validateFindingScope.mockResolvedValue({ available: true, target: null, scanId: null })
  })

  it("requires workspace access and forwards bounded pagination", async () => {
    mocks.getFindingHistoryPage.mockResolvedValue({ items: [], nextCursor: null, total: 100000 })
    const response = await GET(
      new Request(
        "http://localhost/api/findings/finding-1/history?workspaceId=workspace-1&collection=evidence&limit=100"
      ),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "finding:view")
    expect(mocks.getFindingHistoryPage).toHaveBeenCalledWith(
      "finding-1",
      "workspace-1",
      "evidence",
      {
        cursor: undefined,
        limit: 100,
      }
    )
  })

  it("denies history reads without finding:view", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))

    const response = await GET(
      new Request(
        "http://localhost/api/findings/finding-1/history?workspaceId=workspace-1&collection=evidence"
      ),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expectPermissionDenied(
      response,
      mocks.requirePermission.mock.calls,
      "workspace-1",
      "/api/findings/[id]/history",
      "GET"
    )
    expect(mocks.validateFindingScope).not.toHaveBeenCalled()
    expect(mocks.getFindingHistoryPage).not.toHaveBeenCalled()
  })

  it("rejects limits above 100", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/findings/finding-1/history?workspaceId=workspace-1&collection=evidence&limit=101"
      ),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(response.status).toBe(400)
    expect(mocks.getFindingHistoryPage).not.toHaveBeenCalled()
  })

  it("keeps history inside a scan and target scope", async () => {
    mocks.getFindingHistoryPage.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
    const response = await GET(
      new Request(
        "http://localhost/api/findings/finding-1/history?workspaceId=workspace-1&collection=evidence&targetId=target-1&observedInScanId=scan-2"
      ),
      { params: Promise.resolve({ id: "finding-1" }) }
    )

    expect(response.status).toBe(200)
    expect(mocks.validateFindingScope).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
    })
    expect(mocks.getFindingHistoryPage).toHaveBeenCalledWith(
      "finding-1",
      "workspace-1",
      "evidence",
      {
        cursor: undefined,
        limit: 25,
        targetId: "target-1",
        observedInScanId: "scan-2",
      }
    )
  })
})
