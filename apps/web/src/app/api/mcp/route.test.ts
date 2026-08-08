import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyApiKey = vi.fn()
vi.mock("@lyrashield/db", () => ({ verifyApiKey: (...a: unknown[]) => verifyApiKey(...a) }))

const handleRemoteMcpRequest = vi.fn()
vi.mock("@lyrashield/mcp", () => ({
  handleRemoteMcpRequest: (...a: unknown[]) => handleRemoteMcpRequest(...a),
}))

vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
const verifyOAuthBearer = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  verifyOAuthBearer: (...args: unknown[]) => verifyOAuthBearer(...args),
}))

import { POST } from "./route"

function req(auth?: string): Request {
  return new Request("https://app.example.com/api/mcp", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
}

describe("POST /api/mcp (remote MCP endpoint)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("401s with no Authorization header and never touches the engine", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer")
    expect(verifyApiKey).not.toHaveBeenCalled()
    expect(handleRemoteMcpRequest).not.toHaveBeenCalled()
  })

  it("401s when the key fails verification", async () => {
    verifyApiKey.mockResolvedValue(null)
    const res = await POST(req("Bearer lsk_bad"))
    expect(res.status).toBe(401)
    expect(handleRemoteMcpRequest).not.toHaveBeenCalled()
  })

  it("passes the verified key and app base URL to the engine", async () => {
    verifyApiKey.mockResolvedValue({ keyId: "k", workspaceId: "ws-1", scopes: ["read"] })
    handleRemoteMcpRequest.mockResolvedValue(new Response("{}", { status: 200 }))
    const res = await POST(req("Bearer lsk_good"))
    expect(res.status).toBe(200)
    expect(handleRemoteMcpRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        toolContext: { apiBaseUrl: "https://app.example.com", apiKey: "lsk_good" },
        allowMutations: false,
      })
    )
  })

  it("accepts an OAuth bearer but never enables the remote-write bypass", async () => {
    verifyOAuthBearer.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-1",
      scopes: ["lyrashield.read", "lyrashield.write"],
      clientId: "client-1",
    })
    handleRemoteMcpRequest.mockResolvedValue(new Response("{}", { status: 200 }))
    const res = await POST(req("Bearer oauth-token"))
    expect(res.status).toBe(200)
    expect(handleRemoteMcpRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        allowMutations: false,
        toolContext: { apiBaseUrl: "https://app.example.com", apiKey: "oauth-token" },
      })
    )
  })

  it("returns a JSON-RPC 500 when the engine throws", async () => {
    verifyApiKey.mockResolvedValue({ keyId: "k", workspaceId: "ws-1", scopes: ["read"] })
    handleRemoteMcpRequest.mockRejectedValue(new Error("boom"))
    const res = await POST(req("Bearer lsk_good"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe(-32603)
  })
})
