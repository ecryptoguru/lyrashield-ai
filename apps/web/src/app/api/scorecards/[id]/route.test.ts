import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ revokeScorecardShare: vi.fn() }))

const requirePermission = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scorecard: { publish: "scorecard:publish" } },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { revokeScorecardShare } from "@lyrashield/db"
import { DELETE } from "./route"

function makeRequest({ workspaceId = "workspace-1", role = "OWNER" } = {}) {
  requirePermission.mockResolvedValue({
    session: { userId: "user-1" },
    workspace: { role },
  })
  return new Request("http://localhost/api/scorecards/share-1", {
    method: "DELETE",
    body: JSON.stringify({ workspaceId }),
  })
}

describe("DELETE /api/scorecards/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("revokes a scorecard share for an authorized publisher", async () => {
    vi.mocked(revokeScorecardShare).mockResolvedValue({ id: "share-1" } as never)
    const response = await DELETE(makeRequest(), { params: Promise.resolve({ id: "share-1" }) })
    expect(requirePermission).toHaveBeenCalledWith("workspace-1", "scorecard:publish")
    expect(response.status).toBe(200)
    expect(revokeScorecardShare).toHaveBeenCalledWith("share-1", "workspace-1", "user-1")
  })

  it("returns 403 when authorization fails (non-publisher role or insufficient credential scope)", async () => {
    const request = makeRequest()
    requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await DELETE(request, {
      params: Promise.resolve({ id: "share-1" }),
    })

    expect(response.status).toBe(403)
    expect(revokeScorecardShare).not.toHaveBeenCalled()
  })
})
