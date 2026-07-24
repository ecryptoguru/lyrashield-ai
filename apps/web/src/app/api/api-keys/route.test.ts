import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  API_KEY_SCOPES: ["read", "write"],
  prisma: { auditLog: { create: vi.fn() } },
}))
const requireWorkspaceAccess = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { createApiKey, listApiKeys, prisma } from "@lyrashield/db"
import { GET, POST } from "./route"

function sessionResult(overrides: Record<string, unknown> = {}) {
  return {
    session: { userId: "user-1", ...overrides },
    workspace: { role: "ADMIN" },
  }
}

describe("GET /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue(sessionResult())
  })

  it("requires workspaceId", async () => {
    const res = await GET(new Request("http://localhost/api/api-keys"))
    expect(res.status).toBe(400)
  })

  it("requires ADMIN and lists keys", async () => {
    vi.mocked(listApiKeys).mockResolvedValue([])
    const res = await GET(new Request("http://localhost/api/api-keys?workspaceId=ws-1"))
    expect(requireWorkspaceAccess).toHaveBeenCalledWith("ws-1", "ADMIN")
    expect(res.status).toBe(200)
  })

  it("rejects API-key-authenticated callers (no self-management)", async () => {
    requireWorkspaceAccess.mockResolvedValue(
      sessionResult({ apiKey: { keyId: "k", workspaceId: "ws-1", scopes: ["write"] } })
    )
    const res = await GET(new Request("http://localhost/api/api-keys?workspaceId=ws-1"))
    expect(res.status).toBe(403)
    expect(listApiKeys).not.toHaveBeenCalled()
  })
})

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireWorkspaceAccess.mockResolvedValue(sessionResult())
  })

  it("creates a key, audits it, and returns the raw key once", async () => {
    vi.mocked(createApiKey).mockResolvedValue({
      rawKey: "lsk_raw",
      apiKey: { id: "key-1", prefix: "lsk_raw", scopes: ["read"] },
    } as never)

    const res = await POST(
      new Request("http://localhost/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", name: "CI", scopes: ["read"] }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.rawKey).toBe("lsk_raw")
    expect(vi.mocked(prisma.auditLog.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "api_key.created", resourceId: "key-1" }),
      })
    )
  })

  it("rejects invalid scopes at the boundary", async () => {
    const res = await POST(
      new Request("http://localhost/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", name: "CI", scopes: ["admin"] }),
      })
    )
    expect(res.status).toBe(400)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it("rejects API-key-authenticated callers", async () => {
    requireWorkspaceAccess.mockResolvedValue(
      sessionResult({ apiKey: { keyId: "k", workspaceId: "ws-1", scopes: ["write"] } })
    )
    const res = await POST(
      new Request("http://localhost/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", name: "CI", scopes: ["read"] }),
      })
    )
    expect(res.status).toBe(403)
    expect(createApiKey).not.toHaveBeenCalled()
  })

  it("maps the key limit error to a 400", async () => {
    vi.mocked(createApiKey).mockRejectedValue(new Error("KEY_LIMIT_REACHED"))
    const res = await POST(
      new Request("http://localhost/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", name: "CI", scopes: ["read"] }),
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("KEY_LIMIT_REACHED")
  })
})
