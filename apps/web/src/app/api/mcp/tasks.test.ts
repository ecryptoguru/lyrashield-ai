import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyApiKey = vi.fn()
const verifyOAuthBearer = vi.fn()
const requirePermissionMock = vi.fn().mockResolvedValue({})
const claimOrGetAgentOperationMock = vi.fn()
const completeAgentOperationMock = vi.fn()
const getAgentOperationMock = vi.fn()
const listAgentOperationsForTasksMock = vi.fn()
const checkDelegatedOperationAuthorizationMock = vi.fn()
const cancelScanMock = vi.fn()
const scanFindFirstMock = vi.fn()
const scanFindManyMock = vi.fn()

vi.mock("@lyrashield/db", () => ({
  verifyApiKey: (...a: unknown[]) => verifyApiKey(...a),
  TOOL_OPERATION_MAP: {
    lyrashield_scan_target: { canonicalOperation: "scan.create" },
    lyrashield_cancel_scan: { canonicalOperation: "scan.cancel" },
  },
  CANONICAL_OPERATIONS: { SCAN_CREATE: "scan.create" },
  claimOrGetAgentOperation: (...a: unknown[]) => claimOrGetAgentOperationMock(...a),
  completeAgentOperation: (...a: unknown[]) => completeAgentOperationMock(...a),
  failAgentOperation: vi.fn(),
  getAgentOperation: (...a: unknown[]) => getAgentOperationMock(...a),
  listAgentOperationsForTasks: (...a: unknown[]) => listAgentOperationsForTasksMock(...a),
  checkDelegatedOperationAuthorization: (...a: unknown[]) =>
    checkDelegatedOperationAuthorizationMock(...a),
  cancelScan: (...a: unknown[]) => cancelScanMock(...a),
  withWorkspaceRLS: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
    fn({ scan: { findFirst: scanFindFirstMock, findMany: scanFindManyMock } })
  ),
}))

vi.mock("@lyrashield/auth/server", () => ({
  verifyOAuthBearer: (...a: unknown[]) => verifyOAuthBearer(...a),
  requirePermission: (...a: unknown[]) => requirePermissionMock(...a),
}))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { POST } from "./route"

const OAUTH = "Bearer oauth-token"
const PROTOCOL_2025 = "2025-11-25"
const PROTOCOL_2025_06 = "2025-06-18"

function oauthConnection(overrides: Record<string, unknown> = {}) {
  verifyOAuthBearer.mockResolvedValue({
    userId: "user-1",
    workspaceId: "ws-1",
    scopes: ["lyrashield.read", "lyrashield.write"],
    clientId: "client-1",
    connectionId: "conn-1",
    authorizationVersion: 7,
    allowedOperations: ["scan.create", "scan.cancel"],
    allowedTargetIds: [],
    allTargets: true,
    allowedProfiles: ["STANDARD"],
    expiresAt: null,
    ...overrides,
  })
}

function req(params: {
  method: string
  rpcMethod: string
  rpcParams?: Record<string, unknown>
  id?: number
  protocolHeader?: string
  auth?: string
}) {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: params.id ?? 1,
    method: params.rpcMethod,
  }
  if (params.rpcParams) body.params = params.rpcParams
  return new Request("https://app.example.com/api/mcp", {
    method: params.method,
    headers: {
      authorization: params.auth ?? OAUTH,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(params.protocolHeader ? { "mcp-protocol-version": params.protocolHeader } : {}),
    },
    body: JSON.stringify(body),
  })
}

function initializeReq(protocolVersion: string, auth?: string) {
  return req({
    method: "POST",
    rpcMethod: "initialize",
    rpcParams: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
    ...(auth ? { auth } : {}),
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

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    status: "COMPLETED",
    error: null,
    resultReference: "scan-1",
    result: null,
    workspaceId: "ws-1",
    principalType: "OAUTH_CONNECTION",
    principalId: "conn-1",
    connectionId: "conn-1",
    authorizationVersion: 7,
    operationName: "scan.create",
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(Date.now() - 30_000),
    ...overrides,
  }
}

function makeScan(overrides: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    status: "COMPLETED",
    goal: "TEST_APP",
    mode: "STANDARD",
    triggerType: "manual",
    targetId: "t-1",
    startedAt: new Date(Date.now() - 50_000),
    endedAt: new Date(Date.now() - 20_000),
    durationMs: 30000,
    createdAt: new Date(Date.now() - 60_000),
    updatedAt: new Date(Date.now() - 20_000),
    summary: "ok",
    errorCategory: null,
    errorMessage: null,
    target: {
      id: "t-1",
      name: "t",
      type: "URL",
      url: "https://x",
      apiSpecUrl: null,
      repoFullName: null,
    },
    ...overrides,
  }
}

function scanFetchStub() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({
      success: true,
      data: { id: "scan-1", status: "QUEUED", operationId: "rest-op-1" },
    }),
  })) as unknown as typeof fetch
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyApiKey.mockReset()
  verifyOAuthBearer.mockReset()
  claimOrGetAgentOperationMock.mockReset()
  getAgentOperationMock.mockReset()
  listAgentOperationsForTasksMock.mockReset()
  cancelScanMock.mockReset()
  requirePermissionMock.mockResolvedValue({})
  scanFindFirstMock.mockResolvedValue(makeScan())
  scanFindManyMock.mockResolvedValue([makeScan()])
  checkDelegatedOperationAuthorizationMock.mockReturnValue({
    authorized: true,
    canonicalOperation: "scan.create",
  })
})

describe("MCP tasks over the hosted endpoint", () => {
  it("does not advertise tasks on protocol 2025-06-18 (all tools stay forbidden)", async () => {
    oauthConnection()
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tools/list",
        rpcParams: {},
        protocolHeader: PROTOCOL_2025_06,
      })
    )
    const body = await readJson(res)
    const tools = (
      body.result as { tools: Array<{ name: string; execution?: { taskSupport: string } }> }
    ).tools
    expect(tools.every((t) => t.execution?.taskSupport === "forbidden")).toBe(true)
  })

  it("does not advertise tasks capability on initialize for an old client", async () => {
    oauthConnection()
    const res = await POST(initializeReq(PROTOCOL_2025_06))
    const body = await readJson(res)
    const caps = (body.result as { capabilities: Record<string, unknown> }).capabilities
    expect(caps.tasks).toBeUndefined()
  })

  it("advertises tasks capability and optional taskSupport on 2025-11-25 with a connection", async () => {
    oauthConnection()
    const init = await POST(initializeReq(PROTOCOL_2025))
    const initBody = await readJson(init)
    const caps = (initBody.result as { capabilities: Record<string, unknown> }).capabilities
    expect(caps.tasks).toMatchObject({ requests: { tools: { call: {} } }, list: {}, cancel: {} })

    const list = await POST(
      req({ method: "POST", rpcMethod: "tools/list", protocolHeader: PROTOCOL_2025 })
    )
    const listBody = await readJson(list)
    const tools = (
      listBody.result as { tools: Array<{ name: string; execution?: { taskSupport: string } }> }
    ).tools
    const scanTool = tools.find((t) => t.name === "lyrashield_scan_target")!
    expect(scanTool.execution?.taskSupport).toBe("optional")
    const others = tools.filter((t) => t.name !== "lyrashield_scan_target")
    expect(others.every((t) => t.execution?.taskSupport === "forbidden")).toBe(true)
  })

  it("does not advertise tasks for an API-key caller even on 2025-11-25", async () => {
    verifyApiKey.mockResolvedValue({
      keyId: "k",
      workspaceId: "ws-1",
      scopes: ["read", "write"],
      createdById: "user-1",
    })
    const init = await POST(initializeReq(PROTOCOL_2025, "Bearer lsk_write"))
    const body = await readJson(init)
    const caps = (body.result as { capabilities: Record<string, unknown> }).capabilities
    expect(caps.tasks).toBeUndefined()
  })

  it("creates a task through the recorded operation boundary — once", async () => {
    oauthConnection()
    claimOrGetAgentOperationMock.mockResolvedValue({ status: "NEW", operation: { id: "op-1" } })
    completeAgentOperationMock.mockResolvedValue(undefined)
    getAgentOperationMock.mockResolvedValue(
      makeOperation({ status: "COMPLETED", resultReference: "scan-1" })
    )
    scanFindFirstMock.mockResolvedValue(makeScan({ status: "QUEUED" }))
    const fetchSpy = scanFetchStub()
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const res = await POST(
        req({
          method: "POST",
          rpcMethod: "tools/call",
          rpcParams: {
            name: "lyrashield_scan_target",
            arguments: { workspaceId: "ws-1", targetId: "t-1", idempotencyKey: "idem-1" },
            task: {},
          },
          protocolHeader: PROTOCOL_2025,
        })
      )
      const body = await readJson(res)
      const task = (body.result as { task: { taskId: string; status: string } }).task
      expect(task.taskId).toBe("lst_op-1")
      expect(task.status).toBe("working")
      // The operation was claimed exactly once and the scan submitted once.
      expect(claimOrGetAgentOperationMock).toHaveBeenCalledOnce()
      expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "conn-1", idempotencyKey: "idem-1" })
      )
      expect(fetchSpy).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("replays the same task for a duplicate task-augmented call — no second scan", async () => {
    oauthConnection()
    claimOrGetAgentOperationMock.mockResolvedValue({
      status: "REPLAY",
      operation: {
        id: "op-1",
        result: {
          content: [{ type: "text", text: '{"action":"scan_triggered"}' }],
          structuredContent: { action: "scan_triggered", scan: { id: "scan-1" } },
        },
      },
    })
    getAgentOperationMock.mockResolvedValue(makeOperation())
    scanFindFirstMock.mockResolvedValue(makeScan({ status: "RUNNING" }))
    const fetchSpy = scanFetchStub()
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const res = await POST(
        req({
          method: "POST",
          rpcMethod: "tools/call",
          rpcParams: {
            name: "lyrashield_scan_target",
            arguments: { workspaceId: "ws-1", targetId: "t-1", idempotencyKey: "idem-1" },
            task: {},
          },
          protocolHeader: PROTOCOL_2025,
        })
      )
      const body = await readJson(res)
      const task = (body.result as { task: { taskId: string } }).task
      expect(task.taskId).toBe("lst_op-1")
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("denies a task-augmented call when the mutation itself is denied (no task fabricated)", async () => {
    oauthConnection({ allowedOperations: [] })
    checkDelegatedOperationAuthorizationMock.mockReturnValue({
      authorized: false,
      reason: "OPERATION_NOT_GRANTED",
    })
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tools/call",
        rpcParams: {
          name: "lyrashield_scan_target",
          arguments: { workspaceId: "ws-1", targetId: "t-1", idempotencyKey: "idem-1" },
          task: {},
        },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
    expect(claimOrGetAgentOperationMock).not.toHaveBeenCalled()
  })

  it("refuses task augmentation on non task-capable tools", async () => {
    oauthConnection()
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tools/call",
        rpcParams: {
          name: "lyrashield_get_scan_status",
          arguments: { workspaceId: "ws-1", scanId: "scan-1" },
          task: {},
        },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(String((body.error as { message?: string })?.message ?? "")).toMatch(
      /does not support task/i
    )
  })

  it("serves tasks/get for the bound operation with re-authorized scan state", async () => {
    oauthConnection()
    getAgentOperationMock.mockResolvedValue(makeOperation())
    scanFindFirstMock.mockResolvedValue(makeScan({ status: "RUNNING" }))
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/get",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    const task =
      (body.result as { taskId: string; status: string }) ??
      (body.result as { task: { status: string } }).task
    expect(task.status).toBe("working")
    // Membership/permission re-check ran for this request, not at binding time.
    expect(requirePermissionMock).toHaveBeenCalledWith("ws-1", "scan:view")
  })

  it("denies a foreign task id (principal mismatch) with a uniform error", async () => {
    oauthConnection()
    getAgentOperationMock.mockResolvedValue(makeOperation({ principalId: "conn-other" }))
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/get",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
    expect(String((body.error as { message?: string })?.message ?? "")).toMatch(/not found/i)
  })

  it("denies a task bound under a stale authorizationVersion (grant re-scoped)", async () => {
    oauthConnection() // connection is at version 7
    getAgentOperationMock.mockResolvedValue(makeOperation({ authorizationVersion: 5 }))
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/get",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
  })

  it("denies an expired task mapping with a bounded error", async () => {
    oauthConnection()
    getAgentOperationMock.mockResolvedValue(
      makeOperation({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
    )
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/get",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
  })

  it("denies a malformed task id", async () => {
    oauthConnection()
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/get",
        rpcParams: { taskId: "garbage" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
    expect(getAgentOperationMock).not.toHaveBeenCalled()
  })

  it("tasks/result reconstructs a terminal result from the persisted scan row", async () => {
    oauthConnection()
    getAgentOperationMock.mockResolvedValue(makeOperation())
    scanFindFirstMock.mockResolvedValue(makeScan({ status: "COMPLETED" }))
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/result",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    const result = body.result as {
      structuredContent?: { action?: string; scan?: { id?: string } }
    }
    expect(result.structuredContent?.action).toBe("scan_completed")
    expect(result.structuredContent?.scan?.id).toBe("scan-1")
  })

  it("routes tasks/cancel through the canonical scan.cancel path", async () => {
    oauthConnection()
    getAgentOperationMock.mockResolvedValue(makeOperation())
    // Fetch order: SDK pre-check getTask → backend pre-cancel resolve →
    // post-cancel re-resolve sees the CANCELLED durable row.
    scanFindFirstMock
      .mockResolvedValueOnce(makeScan({ status: "RUNNING" }))
      .mockResolvedValueOnce(makeScan({ status: "RUNNING" }))
      .mockResolvedValue(makeScan({ status: "CANCELLED" }))
    cancelScanMock.mockResolvedValue({ id: "scan-1", status: "CANCELLED" })
    checkDelegatedOperationAuthorizationMock.mockReturnValue({
      authorized: true,
      canonicalOperation: "scan.cancel",
    })
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/cancel",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    const task =
      (body.result as { status?: string }) ?? (body.result as { task?: { status: string } }).task
    expect(task.status).toBe("cancelled")
    // Cancel-scope permission and delegated grant were rechecked for this request.
    expect(requirePermissionMock).toHaveBeenCalledWith("ws-1", "scan:cancel")
    expect(checkDelegatedOperationAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationName: "lyrashield_cancel_scan", targetId: "t-1" })
    )
    expect(cancelScanMock).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("denies tasks/cancel when the delegated cancel grant is missing", async () => {
    oauthConnection({ allowedOperations: ["scan.create"] })
    getAgentOperationMock.mockResolvedValue(makeOperation())
    scanFindFirstMock.mockResolvedValue(makeScan({ status: "RUNNING" }))
    checkDelegatedOperationAuthorizationMock.mockReturnValue({
      authorized: false,
      reason: "OPERATION_NOT_GRANTED",
    })
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/cancel",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
    expect(cancelScanMock).not.toHaveBeenCalled()
  })

  it("denies every task method when the connection is revoked (auth layer)", async () => {
    verifyOAuthBearer.mockResolvedValue(null) // revoked/expired token
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/get",
        rpcParams: { taskId: "lst_op-1" },
        protocolHeader: PROTOCOL_2025,
      })
    )
    expect(res.status).toBe(401)
  })

  it("tasks/list only returns the principal's own operations", async () => {
    oauthConnection()
    listAgentOperationsForTasksMock.mockResolvedValue([makeOperation()])
    scanFindManyMock.mockResolvedValue([makeScan()])
    const res = await POST(
      req({
        method: "POST",
        rpcMethod: "tasks/list",
        rpcParams: {},
        protocolHeader: PROTOCOL_2025,
      })
    )
    const body = await readJson(res)
    const tasks = (body.result as { tasks: Array<{ taskId: string }> }).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].taskId).toBe("lst_op-1")
    expect(listAgentOperationsForTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "conn-1", principalType: "OAUTH_CONNECTION" })
    )
  })

  it("keeps the immediate result path for a non-augmented call on 2025-11-25", async () => {
    oauthConnection()
    claimOrGetAgentOperationMock.mockResolvedValue({ status: "NEW", operation: { id: "op-1" } })
    completeAgentOperationMock.mockResolvedValue(undefined)
    const fetchSpy = scanFetchStub()
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const res = await POST(
        req({
          method: "POST",
          rpcMethod: "tools/call",
          rpcParams: {
            name: "lyrashield_scan_target",
            arguments: { workspaceId: "ws-1", targetId: "t-1", idempotencyKey: "idem-1" },
          },
          protocolHeader: PROTOCOL_2025,
        })
      )
      const body = await readJson(res)
      const result = body.result as { structuredContent?: { action?: string } }
      expect(result.structuredContent?.action).toBe("scan_triggered")
      expect(fetchSpy).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
