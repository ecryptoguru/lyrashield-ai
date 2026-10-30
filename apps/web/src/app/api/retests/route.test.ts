import { resolveOAuthReadScope } from "../../../../../../packages/auth/src/oauth-read-scope"
import { GET as V1GET } from "../v1/retests/route"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listRetests: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  resolveOAuthReadScope,
  requirePermission: mocks.requirePermission,
}))
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

it.each([{ targetIds: ["target-1"] }, { targetIds: [] }])(
  "bounds omitted target reads and pagination to $targetIds",
  async ({ targetIds }) => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValueOnce({
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
    mocks.listRetests.mockResolvedValueOnce({ items: [], nextCursor: null })
    const response = await (targetIds.length ? GET : V1GET)(
      new Request(
        "http://localhost/api/retests?workspaceId=ws-1&cursor=cursor-1&findingId=finding-2"
      )
    )
    expect(response.status).toBe(200)
    expect(mocks.listRetests).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", targetIds, cursor: "cursor-1" })
    )
  }
)

it("preserves omitted-target all-target delegation reads", async () => {
  vi.clearAllMocks()
  mocks.requirePermission.mockResolvedValueOnce({
    session: { oauth: { connectionId: "conn-1", allTargets: true, allowedTargetIds: [] } },
  } as never)
  mocks.listRetests.mockResolvedValueOnce({ items: [], nextCursor: null })
  const response = await V1GET(new Request("http://localhost/api/retests?workspaceId=ws-1"))
  expect(response.status).toBe(200)
  expect(mocks.listRetests.mock.calls.at(-1)?.[0]).not.toHaveProperty("targetIds")
})
