import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: vi.fn() }),
}))

const requireWorkspaceAccess = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
}))

import { POST } from "./route"

function makeRequest({ workspaceId = "workspace-1", apiKey }: { workspaceId?: string; apiKey?: { keyId: string; workspaceId: string; scopes: string[] } } = {}) {
  requireWorkspaceAccess.mockResolvedValue({
    session: { userId: "user-1", apiKey },
    workspace: { role: "MEMBER" },
  })
  return new Request("http://localhost/api/workspaces/active", {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  })
}

describe("POST /api/workspaces/active", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sets the active workspace cookie for a session user", async () => {
    const response = await POST(makeRequest())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toMatchObject({ workspaceId: "workspace-1" })
  })

  it("blocks a read-only API key from setting the active workspace", async () => {
    const response = await POST(
      makeRequest({ apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read"] } })
    )
    expect(response.status).toBe(403)
  })

  it("allows a write-scope API key to set the active workspace", async () => {
    const response = await POST(
      makeRequest({ apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read", "write"] } })
    )
    expect(response.status).toBe(200)
  })
})
