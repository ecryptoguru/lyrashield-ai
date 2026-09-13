import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyApiKey = vi.fn()
const createApprovalMock = vi.fn()
const claimOrGetAgentOperationMock = vi.fn()
const completeAgentOperationMock = vi.fn()
const checkDelegatedOperationAuthorizationMock = vi.fn()
vi.mock("@lyrashield/db", () => ({
  verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
  TOOL_OPERATION_MAP: {
    lyrashield_scan_target: { canonicalOperation: "scan.create" },
    lyrashield_create_report: { canonicalOperation: "report.create" },
  },
  createApproval: (...a: unknown[]) => createApprovalMock(...a),
  findPendingApprovalByHash: vi.fn(),
  getApproval: vi.fn(),
  claimApprovalExecution: vi.fn(),
  completeApprovalExecution: vi.fn(),
  failApprovalExecution: vi.fn(),
  claimOrGetAgentOperation: (...a: unknown[]) => claimOrGetAgentOperationMock(...a),
  completeAgentOperation: (...a: unknown[]) => completeAgentOperationMock(...a),
  failAgentOperation: vi.fn(),
  checkDelegatedOperationAuthorization: (...a: unknown[]) =>
    checkDelegatedOperationAuthorizationMock(...a),
  withWorkspaceRLS: vi.fn(),
}))

const handleRemoteMcpRequest = vi.fn()
vi.mock("@lyrashield/mcp", async () => {
  const actual = await vi.importActual<typeof import("@lyrashield/mcp")>("@lyrashield/mcp")
  return {
    ...actual,
    handleRemoteMcpRequest: (...a: unknown[]) => handleRemoteMcpRequest(...a),
  }
})

vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
const verifyOAuthBearer = vi.fn()
const requirePermissionMock = vi.fn().mockResolvedValue({})
vi.mock("@lyrashield/auth/server", () => ({
  verifyOAuthBearer: (...args: unknown[]) => verifyOAuthBearer(...args),
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
}))

import { POST } from "./route"

function req(auth?: string): Request {
  return new Request("https://app.example.com/api/mcp", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
}

function toolCallReq(auth: string, tool: string, args: Record<string, unknown>): Request {
  return new Request("https://app.example.com/api/mcp", {
    method: "POST",
    headers: {
      authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"))
    return line ? JSON.parse(line.slice(5).trim()) : {}
  }
  return JSON.parse(text)
}

async function realTransport(...args: unknown[]) {
  const actual = await vi.importActual<typeof import("@lyrashield/mcp")>("@lyrashield/mcp")
  return actual.handleRemoteMcpRequest(
    ...(args as Parameters<typeof actual.handleRemoteMcpRequest>)
  )
}

describe("POST /api/mcp (remote MCP endpoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handleRemoteMcpRequest.mockReset()
    requirePermissionMock.mockResolvedValue({})
  })

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
        toolContext: expect.objectContaining({
          apiBaseUrl: "https://app.example.com",
          apiKey: "lsk_good",
          allowAutoDetect: false,
        }),
        allowMutations: false,
      })
    )
  })

  it("a write-scoped API key calling a mutating tool gets connect_required and nothing runs", async () => {
    verifyApiKey.mockResolvedValue({
      keyId: "k",
      workspaceId: "ws-1",
      scopes: ["read", "write"],
      createdById: "user-1",
    })
    handleRemoteMcpRequest.mockImplementation(realTransport)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const res = await POST(
        toolCallReq("Bearer lsk_write", "lyrashield_scan_target", {
          workspaceId: "ws-1",
          targetId: "t-1",
        })
      )
      expect(res.status).toBe(200)
      const body = await readJson(res)
      const result = body.result as {
        isError?: boolean
        structuredContent?: Record<string, unknown>
      }
      expect(result?.isError).toBe(true)
      expect(result?.structuredContent).toMatchObject({
        code: "connect_required",
        connectUrl: "https://app.example.com/dashboard/connections",
        docsUrl: "https://lyrashieldai.com/docs/approvals",
      })
      // No approval queued, no tool executed, no upstream REST call.
      expect(createApprovalMock).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a read-only key is denied on scope, not offered connect", async () => {
    verifyApiKey.mockResolvedValue({
      keyId: "k",
      workspaceId: "ws-1",
      scopes: ["read"],
      createdById: "user-1",
    })
    handleRemoteMcpRequest.mockImplementation(realTransport)
    const res = await POST(
      toolCallReq("Bearer lsk_read", "lyrashield_scan_target", {
        workspaceId: "ws-1",
        targetId: "t-1",
      })
    )
    const body = await readJson(res)
    const result = body.result as {
      isError?: boolean
      content?: Array<{ text: string }>
      structuredContent?: Record<string, unknown>
    }
    expect(result?.isError).toBe(true)
    expect(result?.structuredContent?.code).not.toBe("connect_required")
    expect(result?.content?.[0]?.text).toContain("write scope")
    expect(createApprovalMock).not.toHaveBeenCalled()
  })

  it("an OAuth token with an ACTIVE connection executes through the delegated path", async () => {
    verifyOAuthBearer.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-1",
      scopes: ["lyrashield.read", "lyrashield.write"],
      clientId: "client-1",
      connectionId: "conn-1",
      authorizationVersion: 1,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD"],
      expiresAt: null,
    })
    checkDelegatedOperationAuthorizationMock.mockReturnValue({
      authorized: true,
      canonicalOperation: "scan.create",
    })
    claimOrGetAgentOperationMock.mockResolvedValue({
      status: "NEW",
      operation: { id: "op-1" },
    })
    completeAgentOperationMock.mockResolvedValue(undefined)
    handleRemoteMcpRequest.mockImplementation(realTransport)
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ success: true, data: { id: "scan-1", status: "QUEUED" } }),
    }))
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const res = await POST(
        toolCallReq("Bearer oauth-token", "lyrashield_scan_target", {
          workspaceId: "ws-1",
          targetId: "t-1",
          idempotencyKey: "idem-1",
        })
      )
      const body = await readJson(res)
      const result = body.result as {
        isError?: boolean
        structuredContent?: Record<string, unknown>
      }
      expect(result?.isError).toBeFalsy()
      expect(result?.structuredContent).toMatchObject({ action: "scan_triggered" })
      expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-1",
          workspaceId: "ws-1",
          idempotencyKey: "idem-1",
        })
      )
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(completeAgentOperationMock).toHaveBeenCalledWith("op-1", "ws-1", expect.any(Object))
    } finally {
      vi.unstubAllGlobals()
    }
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
        toolContext: expect.objectContaining({
          apiBaseUrl: "https://app.example.com",
          apiKey: "oauth-token",
          allowAutoDetect: false,
        }),
      })
    )
  })

  it("returns a structured failure when credential verification is unavailable", async () => {
    verifyApiKey.mockRejectedValueOnce(new Error("database unavailable"))
    const response = await POST(req("Bearer lsk_good"))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
    })
    expect(handleRemoteMcpRequest).not.toHaveBeenCalled()
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
