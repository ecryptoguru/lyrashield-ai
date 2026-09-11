import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: vi.fn() }),
  headers: () => Promise.resolve(new Headers()),
}))

const updateSessionMock = vi.fn()
const requireWorkspaceAccess = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth/server", () => ({
  requireWorkspaceAccess: (...args: unknown[]) => requireWorkspaceAccess(...args),
  assertBrowserSession: (session: { apiKey?: unknown; oauth?: unknown }) => {
    if (session.apiKey || session.oauth) throw new Error("FORBIDDEN")
  },
  auth: { api: { updateSession: (...args: unknown[]) => updateSessionMock(...args) } },
}))

import { POST } from "./route"

function makeRequest({
  workspaceId = "workspace-1",
  apiKey,
  oauth,
}: {
  workspaceId?: string
  apiKey?: { keyId: string; workspaceId: string; scopes: string[] }
  oauth?: { userId: string; workspaceId: string; scopes: string[] }
} = {}) {
  requireWorkspaceAccess.mockResolvedValue({
    session: { userId: "user-1", apiKey, oauth },
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
    expect(updateSessionMock).toHaveBeenCalled()
  })

  it("rejects a read-only API key — workspace switching is browser-only", async () => {
    const response = await POST(
      makeRequest({ apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read"] } })
    )
    expect(response.status).toBe(403)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("rejects a write-scope API key — a bound credential has exactly one workspace", async () => {
    const response = await POST(
      makeRequest({
        apiKey: { keyId: "k-1", workspaceId: "workspace-1", scopes: ["read", "write"] },
      })
    )
    expect(response.status).toBe(403)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("rejects an OAuth session regardless of scope", async () => {
    const response = await POST(
      makeRequest({
        oauth: {
          userId: "user-1",
          workspaceId: "workspace-1",
          scopes: ["lyrashield.read", "lyrashield.write"],
        },
      })
    )
    expect(response.status).toBe(403)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })
})
