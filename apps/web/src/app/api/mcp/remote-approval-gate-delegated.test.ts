import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermissionMock = vi.fn().mockResolvedValue({})
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
}))

const createApprovalMock = vi.fn()
const findPendingApprovalByHashMock = vi.fn()
const claimOrGetAgentOperationMock = vi.fn()
const completeAgentOperationMock = vi.fn()
const failAgentOperationMock = vi.fn()
const callToolMock = vi.fn()

vi.mock("@lyrashield/db", () => ({
  TOOL_OPERATION_MAP: { lyrashield_scan_target: { canonicalOperation: "scan.create" } },
  createApproval: (...args: unknown[]) => createApprovalMock(...args),
  findPendingApprovalByHash: (...args: unknown[]) => findPendingApprovalByHashMock(...args),
  getApproval: vi.fn(),
  claimApprovalExecution: vi.fn(),
  completeApprovalExecution: vi.fn(),
  failApprovalExecution: vi.fn(),
  hashInput: vi.fn().mockReturnValue("input-hash"),
  verifyInputHash: vi.fn().mockReturnValue(true),
  claimOrGetAgentOperation: (...args: unknown[]) => claimOrGetAgentOperationMock(...args),
  completeAgentOperation: (...args: unknown[]) => completeAgentOperationMock(...args),
  failAgentOperation: (...args: unknown[]) => failAgentOperationMock(...args),
  hashOperationInput: vi.fn().mockReturnValue("op-hash"),
  checkDelegatedOperationAuthorization: vi
    .fn()
    .mockImplementation(({ operationName, connection }) => {
      if (
        connection?.allowedOperations?.includes("scan.create") &&
        operationName === "lyrashield_scan_target"
      ) {
        return { authorized: true, canonicalOperation: "scan.create" }
      }
      return { authorized: false, code: "OPERATION_NOT_GRANTED", reason: "Operation not granted" }
    }),
  prisma: { finding: { findFirst: vi.fn() }, scan: { findFirst: vi.fn() } },
  withWorkspaceRLS: vi.fn(),
}))

vi.mock("@lyrashield/mcp", () => {
  return {
    McpServer: class {
      callTool(...args: unknown[]) {
        return callToolMock(...args)
      }
    },
  }
})

vi.mock("@lyrashield/config", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
    LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS: "false",
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("../../../lib/rate-limit", () => ({
  checkApprovalCreateRateLimit: vi.fn().mockResolvedValue({ limited: false, retryAfter: 0 }),
}))

import { makeRemoteApprovalGate } from "./remote-approval-gate"

describe("makeRemoteApprovalGate - Delegated vs Reviewed Parity", () => {
  const apiKeyInfo = {
    workspaceId: "ws-1",
    scopes: ["write", "lyrashield.write"],
    createdById: "user-1",
    keyId: "key-1",
  }
  const toolContext = {
    apiBaseUrl: "https://app.lyrashieldai.com",
    apiKey: "test-key",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    claimOrGetAgentOperationMock.mockReset()
  })

  it("denies cached results after live membership or permission loss", async () => {
    requirePermissionMock.mockRejectedValueOnce(new Error("FORBIDDEN"))
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "REPLAY",
      operation: { id: "old-op", result: { private: "stored" } },
    })
    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      toolContext,
      connection: {
        id: "conn-1",
        workspaceId: "ws-1",
        status: "ACTIVE",
        authorizationVersion: 1,
        allowedOperations: ["scan.create"],
        allowedTargetIds: [],
        allTargets: true,
        allowedProfiles: ["STANDARD"],
        expiresAt: null,
      },
    })
    expect(
      await gate("lyrashield_scan_target", {
        targetId: "target-1",
        mode: "STANDARD",
        idempotencyKey: "old-op",
      })
    ).toEqual({
      approved: false,
      reason: "Current workspace access does not authorize this operation.",
    })
    expect(claimOrGetAgentOperationMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it("executes seamlessly when delegated connection grant authorizes the tool", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["SAFE", "QUICK", "STANDARD"],
      expiresAt: null,
    }

    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "op-123" },
    })

    const expectedToolResult = {
      content: [{ type: "text", text: '{"scanId":"scan-999"}' }],
      structuredContent: { scanId: "scan-999" },
    }
    callToolMock.mockResolvedValueOnce(expectedToolResult)

    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection,
      toolContext,
    })

    const result = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "op-123",
    })

    expect(result.approved).toBe(true)
    if (result.approved) {
      expect(result.result).toEqual(expectedToolResult)
    }
    // Verifies no approval was created in Review Queue
    expect(createApprovalMock).not.toHaveBeenCalled()
    // Verifies operation was completed
    expect(completeAgentOperationMock).toHaveBeenCalledWith("op-123", "ws-1", {
      result: {
        content: expectedToolResult.content,
        isError: undefined,
        structuredContent: expectedToolResult.structuredContent,
      },
    })
  })

  it("replays stored result for duplicate idempotent requests without re-executing tool", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["SAFE", "QUICK", "STANDARD"],
      expiresAt: null,
    }

    const cachedResult = {
      content: [{ type: "text", text: '{"scanId":"scan-999"}' }],
      structuredContent: { scanId: "scan-999" },
    }

    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "REPLAY",
      operation: { id: "op-123", result: cachedResult },
    })

    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection,
      toolContext,
    })

    const result = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "idem-key-1",
    })

    expect(result.approved).toBe(true)
    if (result.approved) {
      expect(result.result).toEqual(cachedResult)
    }
    // Tool was NOT re-executed
    expect(callToolMock).not.toHaveBeenCalled()
    expect(completeAgentOperationMock).not.toHaveBeenCalled()
  })

  it("returns an operation reference without executing when the same action is in progress", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD"],
      expiresAt: null,
    }
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "IN_PROGRESS",
      operation: { id: "op-running", status: "EXECUTING" },
    })

    const result = await makeRemoteApprovalGate({ apiKeyInfo, connection, toolContext })(
      "lyrashield_scan_target",
      { targetId: "target-1", mode: "STANDARD", idempotencyKey: "same-action" }
    )

    expect(result).toMatchObject({
      approved: true,
      result: { structuredContent: { operationId: "op-running", status: "EXECUTING" } },
    })
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it("returns conflict error when idempotency key is reused with conflicting input", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["SAFE", "QUICK", "STANDARD"],
      expiresAt: null,
    }

    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "CONFLICT",
      message: "Idempotency conflict",
    })

    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection,
      toolContext,
    })

    const result = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "idem-key-1",
    })

    expect(result).toMatchObject({
      approved: false,
      reason: expect.stringContaining("Idempotency conflict"),
    })
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it("denies out-of-grant connection operations without creating a review-queue bypass", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: [], // No mutating operations granted!
      allowedTargetIds: [],
      allTargets: false,
      allowedProfiles: ["SAFE", "QUICK", "STANDARD"],
      expiresAt: null,
    }

    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection,
      toolContext,
    })

    const result = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
    })

    expect(result).toMatchObject({
      approved: false,
      reason: expect.stringContaining("Update this connection's authorized workflows"),
    })
    expect(createApprovalMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
  })
})
