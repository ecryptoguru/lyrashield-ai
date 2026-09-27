import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requirePermission: vi.fn(),
  resolveSyncCredential: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requireAuth: mocks.requireAuth,
  requirePermission: mocks.requirePermission,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {},
  withWorkspaceRLS: vi.fn(),
}))
vi.mock("@lyrashield/config", () => ({
  env: { LYRASHIELD_SYNC_MAX_FINDINGS_PER_BATCH: 100 },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("../../../../lib/sync-license-auth", () => ({
  markLegacySyncResponse: (response: Response) => response,
  resolveSyncCredential: mocks.resolveSyncCredential,
}))

import { POST } from "./route"

const session = {
  userId: "user-1",
  userEmail: "user@example.com",
  userName: "User",
  userImage: null,
  sessionId: "session-1",
}

async function submit() {
  return POST(
    new Request("https://app.example.com/api/sync/findings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", findings: [] }),
    })
  )
}

describe("POST /api/sync/findings workspace authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(session)
    mocks.requirePermission.mockResolvedValue({ workspace: { role: "OWNER" } })
    mocks.resolveSyncCredential.mockResolvedValue({
      ok: false,
      code: "SYNC_NOT_CONNECTED",
      message: "Sync has not been established",
      status: 409,
    })
  })

  it("requires finding:update and allows a workspace writer through permission checks", async () => {
    const response = await submit()

    expect(response.status).toBe(409)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "finding:update")
    expect(mocks.resolveSyncCredential).toHaveBeenCalledOnce()
  })

  it("denies a Viewer even though the shared permission overlay includes operational permissions", async () => {
    mocks.requirePermission.mockResolvedValue({ workspace: { role: "VIEWER" } })

    const response = await submit()

    expect(response.status).toBe(403)
    expect(mocks.resolveSyncCredential).not.toHaveBeenCalled()
  })

  it.each(["suspended membership", "non-member"])("denies a %s", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    const response = await submit()

    expect(response.status).toBe(403)
    expect(mocks.resolveSyncCredential).not.toHaveBeenCalled()
  })
})
