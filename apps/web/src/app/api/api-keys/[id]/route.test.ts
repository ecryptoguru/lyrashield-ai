import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  revokeApiKey: vi.fn(),
  prisma: { auditLog: { create: vi.fn() } },
}))
const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { revokeApiKey, prisma } from "@lyrashield/db"
import { DELETE } from "./route"

function call(id = "key-1", workspaceId = "ws-1") {
  return DELETE(
    new Request(`http://localhost/api/api-keys/${id}?workspaceId=${workspaceId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) }
  )
}

describe("DELETE /api/api-keys/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "ADMIN" },
    })
  })

  it("revokes and audits", async () => {
    vi.mocked(revokeApiKey).mockResolvedValue(true)
    const res = await call()
    expect(res.status).toBe(200)
    expect(revokeApiKey).toHaveBeenCalledWith("key-1", "ws-1")
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "api_key.revoked", resourceId: "key-1" }),
      })
    )
  })

  it("404s for unknown or already-revoked keys without auditing", async () => {
    vi.mocked(revokeApiKey).mockResolvedValue(false)
    const res = await call()
    expect(res.status).toBe(404)
    expect(vi.mocked(prisma.auditLog.create)).not.toHaveBeenCalled()
  })

  it("rejects API-key-authenticated callers", async () => {
    requireWorkspaceAccess.mockResolvedValue({
      session: { userId: "user-1", apiKey: { keyId: "k", workspaceId: "ws-1", scopes: ["write"] } },
      workspace: { role: "ADMIN" },
    })
    const res = await call()
    expect(res.status).toBe(403)
    expect(revokeApiKey).not.toHaveBeenCalled()
  })
})
