import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({ revokeScorecardShare: vi.fn() }))

const requireWorkspaceAccess = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { revokeScorecardShare } from "@lyrashield/db"
import { DELETE } from "./route"

function makeRequest({
  workspaceId = "workspace-1",
  role = "OWNER",
  apiKey,
}: {
  workspaceId?: string
  role?: string
  apiKey?: { keyId: string; workspaceId: string; scopes: string[] }
} = {}) {
  requireWorkspaceAccess.mockResolvedValue({
    session: { userId: "user-1", apiKey },
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

  it("revokes a scorecard share for an allowed user", async () => {
    vi.mocked(revokeScorecardShare).mockResolvedValue({ id: "share-1" } as never)
    const response = await DELETE(makeRequest(), { params: Promise.resolve({ id: "share-1" }) })
    expect(response.status).toBe(200)
    expect(revokeScorecardShare).toHaveBeenCalledWith("share-1", "workspace-1", "user-1")
  })

  it("allows a write-scope API key to revoke a share", async () => {
    vi.mocked(revokeScorecardShare).mockResolvedValue({ id: "share-1" } as never)
    const response = await DELETE(
      makeRequest({
        apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read", "write"] },
      }),
      { params: Promise.resolve({ id: "share-1" }) }
    )
    expect(response.status).toBe(200)
    expect(revokeScorecardShare).toHaveBeenCalled()
  })

  it("blocks a read-only API key from revoking a share", async () => {
    const response = await DELETE(
      makeRequest({ apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read"] } }),
      { params: Promise.resolve({ id: "share-1" }) }
    )
    expect(response.status).toBe(403)
    expect(revokeScorecardShare).not.toHaveBeenCalled()
  })
})
