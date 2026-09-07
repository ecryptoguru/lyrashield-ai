import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn(), getFindingHistoryPage: vi.fn() }))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/db", () => ({ getFindingHistoryPage: mocks.getFindingHistoryPage }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("finding history route", () => {
  beforeEach(() => vi.clearAllMocks())

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
})
