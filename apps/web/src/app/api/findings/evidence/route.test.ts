import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listEvidenceFindings: vi.fn(),
  validateFindingScope: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  listEvidenceFindings: mocks.listEvidenceFindings,
  validateFindingScope: mocks.validateFindingScope,
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { finding: { view: "finding:view" } } }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { GET } from "./route"
import { expectPermissionDenied } from "@/__tests__/route-permission-manifest"

describe("GET /api/findings/evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.validateFindingScope.mockResolvedValue({ available: true, target: null, scanId: null })
    mocks.listEvidenceFindings.mockResolvedValue({ items: [], nextCursor: null })
  })

  it("validates scope and forwards cursor pagination", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/findings/evidence?workspaceId=ws-1&targetId=target-1&observedInScanId=scan-2&cursor=finding-25&limit=50"
      )
    )

    expect(response.status).toBe(200)
    expect(mocks.validateFindingScope).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
    })
    expect(mocks.listEvidenceFindings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "target-1",
      observedInScanId: "scan-2",
      cursor: "finding-25",
      limit: 50,
    })
  })

  it("does not widen an unavailable scope", async () => {
    mocks.validateFindingScope.mockResolvedValue({ available: false, target: null, scanId: null })

    const response = await GET(
      new Request(
        "http://localhost/api/findings/evidence?workspaceId=ws-1&observedInScanId=foreign-scan"
      )
    )

    expect(response.status).toBe(400)
    expect(mocks.listEvidenceFindings).not.toHaveBeenCalled()
  })

  it("denies evidence-finding reads without finding:view", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))
    const response = await GET(
      new Request("http://localhost/api/findings/evidence?workspaceId=ws-1")
    )
    expectPermissionDenied(
      response,
      mocks.requirePermission.mock.calls,
      "ws-1",
      "/api/findings/evidence",
      "GET"
    )
    expect(mocks.listEvidenceFindings).not.toHaveBeenCalled()
  })
})
