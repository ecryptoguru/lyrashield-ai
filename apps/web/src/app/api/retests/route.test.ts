import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listRetests: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { retest: { view: "retest:view" } } }))
vi.mock("@lyrashield/db", () => ({ listRetests: mocks.listRetests }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: mocks.loggerError } }))

import { GET } from "./route"

function request(query: string) {
  return new Request(`http://localhost/api/retests${query}`)
}

describe("GET /api/retests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.listRetests.mockResolvedValue({
      items: [{ id: "retest-1", workspaceId: "ws-1", status: "VALIDATED" }],
      nextCursor: "retest-next",
    })
  })

  it("returns retests only after authorizing the requested workspace and forwards its filters", async () => {
    const response = await GET(
      request("?workspaceId=ws-1&findingId=finding-1&status=VALIDATED&cursor=cursor-1&limit=7")
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: {
        items: [{ id: "retest-1", workspaceId: "ws-1", status: "VALIDATED" }],
        nextCursor: "retest-next",
      },
    })
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "retest:view")
    expect(mocks.listRetests).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      findingId: "finding-1",
      status: "VALIDATED",
      cursor: "cursor-1",
      limit: 7,
    })
  })

  it.each([
    ["a viewer without retest access", "ws-1"],
    ["a member of a different workspace", "ws-other"],
  ])("does not return retest data to %s", async (_caller, workspaceId) => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await GET(request(`?workspaceId=${workspaceId}`))

    expect(response.status).toBe(403)
    expect(mocks.requirePermission).toHaveBeenCalledWith(workspaceId, "retest:view")
    expect(mocks.listRetests).not.toHaveBeenCalled()
  })

  it("rejects a request without workspace scope before querying retests", async () => {
    const response = await GET(request(""))

    expect(response.status).toBe(400)
    expect(mocks.requirePermission).not.toHaveBeenCalled()
    expect(mocks.listRetests).not.toHaveBeenCalled()
  })
})
