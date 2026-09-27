import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listFixProposals: vi.fn(),
  validateFindingScope: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  listFixProposals: mocks.listFixProposals,
  validateFindingScope: mocks.validateFindingScope,
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("GET /api/fix-proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.validateFindingScope.mockResolvedValue({ available: true, target: null, scanId: null })
    mocks.listFixProposals.mockResolvedValue({ items: [], nextCursor: null })
  })

  it("passes the observed scan and target scope through to the shared query", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/fix-proposals?workspaceId=ws-1&targetId=target-1&observedInScanId=scan-2&cursor=proposal-1"
      )
    )

    expect(response.status).toBe(200)
    expect(mocks.validateFindingScope).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
    })
    expect(mocks.listFixProposals).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
      cursor: "proposal-1",
      limit: 50,
    })
  })

  it("rejects an unavailable scope before listing fixes", async () => {
    mocks.validateFindingScope.mockResolvedValue({ available: false, target: null, scanId: null })

    const response = await GET(
      new Request(
        "http://localhost/api/fix-proposals?workspaceId=ws-1&observedInScanId=foreign-scan"
      )
    )

    expect(response.status).toBe(400)
    expect(mocks.listFixProposals).not.toHaveBeenCalled()
  })
})
