import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermissionMock = vi.fn().mockResolvedValue({})
const requireOAuthPermissionMock = vi.fn((...args: unknown[]) => {
  const [oauth, permission] = args as [{ workspaceId: string }, string]
  return requirePermissionMock(oauth.workspaceId, permission)
})
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
  requireOAuthPermission: (...args: unknown[]) => requireOAuthPermissionMock(...args),
}))

const createApprovalMock = vi.fn()
const findPendingApprovalByHashMock = vi.fn()
const claimOrGetAgentOperationMock = vi.fn()
const completeAgentOperationMock = vi.fn()
const failAgentOperationMock = vi.fn()
const callToolMock = vi.fn()

vi.mock("@lyrashield/db", () => ({
  TOOL_OPERATION_MAP: {
    lyrashield_scan_target: { canonicalOperation: "scan.create" },
    lyrashield_cancel_scan: { canonicalOperation: "scan.cancel" },
    lyrashield_list_scan_attachments: { canonicalOperation: "scan_attachment.list" },
    lyrashield_upload_scan_attachment: { canonicalOperation: "scan_attachment.upload" },
    lyrashield_delete_scan_attachment: { canonicalOperation: "scan_attachment.delete" },
    lyrashield_request_fix_pr: { canonicalOperation: "fix_pr.create" },
  },
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
  toJsonObject: (value: object) => JSON.parse(JSON.stringify(value)),
  hashOperationInput: vi.fn().mockReturnValue("op-hash"),
  checkDelegatedOperationAuthorization: vi
    .fn()
    .mockImplementation(({ operationName, connection, targetId, profile }) => {
      if (
        connection?.allowedOperations?.includes("scan.create") &&
        operationName === "lyrashield_scan_target"
      ) {
        return { authorized: true, canonicalOperation: "scan.create" }
      }
      if (
        connection?.allowedOperations?.includes("scan.cancel") &&
        operationName === "lyrashield_cancel_scan" &&
        // Cancellation is non-billable: the gate must not resolve the scan's
        // mode into a profile check, or a cancel-only grant could never pass.
        profile === undefined &&
        (connection?.allTargets || connection?.allowedTargetIds?.includes(targetId))
      ) {
        return { authorized: true, canonicalOperation: "scan.cancel" }
      }
      if (
        connection?.allowedOperations?.includes("scan_attachment.upload") &&
        operationName === "lyrashield_upload_scan_attachment" &&
        connection?.allTargets
      ) {
        return { authorized: true, canonicalOperation: "scan_attachment.upload" }
      }
      if (
        connection?.allowedOperations?.includes("scan_attachment.delete") &&
        operationName === "lyrashield_delete_scan_attachment" &&
        connection?.allTargets
      ) {
        return { authorized: true, canonicalOperation: "scan_attachment.delete" }
      }
      if (
        connection?.allowedOperations?.includes("fix_pr.create") &&
        operationName === "lyrashield_request_fix_pr" &&
        (connection?.allTargets || connection?.allowedTargetIds?.includes(targetId))
      ) {
        return { authorized: true, canonicalOperation: "fix_pr.create" }
      }

      return { authorized: false, code: "OPERATION_NOT_GRANTED", reason: "Operation not granted" }
    }),
  prisma: { finding: { findFirst: vi.fn() }, scan: { findFirst: vi.fn() } },
  withWorkspaceRLS: vi.fn((_workspaceId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        finding: { findFirst: vi.fn().mockResolvedValue({ targetId: "target-1" }) },
        fixProposal: {
          findFirst: vi.fn().mockResolvedValue({ finding: { targetId: "target-1" } }),
        },

        scan: {
          findFirst: vi.fn().mockResolvedValue({ targetId: "target-1", mode: "STANDARD" }),
        },
      })
    )
  ),
}))

vi.mock("@lyrashield/mcp", async () => {
  const actual = await vi.importActual<typeof import("@lyrashield/mcp")>("@lyrashield/mcp")
  return {
    ...actual,
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
  },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock("../../../lib/rate-limit", () => ({
  checkApprovalCreateRateLimit: vi.fn().mockResolvedValue({ limited: false, retryAfter: 0 }),
}))

import { McpToolResultSchema } from "@lyrashield/mcp"
import { makeRemoteApprovalGate as createRemoteApprovalGate } from "./remote-approval-gate"
// The real canonical-input hasher — a pure module, so it can be imported
// directly without the mocked @lyrashield/db surface or a Prisma client. A
// faithful unit ledger must apply the same hashing the Postgres claim path
// does so a changed input under one idempotency key conflicts.
import { hashOperationInput as realHashOperationInput } from "@lyrashield/db/src/agent-operation-hash"

function makeRemoteApprovalGate(options: Parameters<typeof createRemoteApprovalGate>[0]) {
  if (options.oauthContext || !options.connection) return createRemoteApprovalGate(options)

  return createRemoteApprovalGate({
    ...options,
    oauthContext: {
      userId: options.apiKeyInfo.createdById,
      workspaceId: options.apiKeyInfo.workspaceId,
      scopes: options.apiKeyInfo.scopes,
      connectionId: options.connection.id,
      authorizationVersion: options.connection.authorizationVersion,
      allowedOperations: options.connection.allowedOperations,
      allowedTargetIds: options.connection.allowedTargetIds,
      allTargets: options.connection.allTargets,
      allowedProfiles: options.connection.allowedProfiles,
      expiresAt: options.connection.expiresAt,
    },
  })
}

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
    completeAgentOperationMock.mockResolvedValue({ status: "COMPLETED" })
    failAgentOperationMock.mockResolvedValue({ status: "FAILED" })
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

  it("denies an idempotent replay for a removed bearer user despite an owner cookie session", async () => {
    const oauthContext = {
      userId: "bearer-user-a",
      workspaceId: "ws-1",
      scopes: ["lyrashield.read", "lyrashield.write"],
      connectionId: "conn-1",
      authorizationVersion: 7,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD"],
      expiresAt: null,
    }
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 7,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD"],
      expiresAt: null,
    }
    const authInfo = { ...apiKeyInfo, createdById: oauthContext.userId }
    requirePermissionMock.mockResolvedValueOnce({
      session: { userId: "owner-cookie-user-b" },
      workspace: { role: "OWNER" },
    })
    requireOAuthPermissionMock.mockRejectedValueOnce(new Error("FORBIDDEN"))
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "REPLAY",
      operation: { id: "old-op", result: { private: "stored" } },
    })

    const gate = createRemoteApprovalGate({
      apiKeyInfo: authInfo,
      oauthContext,
      connection,
      toolContext,
    })
    const result = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "old-operation-key",
    })

    expect(result).toEqual({
      approved: false,
      reason: "Current workspace access does not authorize this operation.",
    })
    expect(requireOAuthPermissionMock).toHaveBeenCalledWith(oauthContext, "scan:create")
    expect(requirePermissionMock).not.toHaveBeenCalled()
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

    if (!result.approved || !result.result) throw new Error("Expected approved tool result")
    // The approved result carries the durable operation id stamp so the
    // MCP task layer can bind a task id to this exact ledger row.
    expect(result.result.structuredContent).toEqual({
      scanId: "scan-999",
      operationId: "op-123",
    })
    expect(result.result.content[0]?.text).toContain('"operationId": "op-123"')
    // Verifies no approval was created in Review Queue
    expect(createApprovalMock).not.toHaveBeenCalled()
    // Verifies operation was completed with the stamped result retained
    expect(completeAgentOperationMock).toHaveBeenCalledWith("op-123", "ws-1", {
      result: {
        content: expect.any(Array),
        isError: undefined,
        structuredContent: { scanId: "scan-999", operationId: "op-123" },
      },
    })
  })

  it.each(["returned", "thrown"])(
    "retains an ambiguous %s handler error without completing or retrying",
    async (kind) => {
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
      const errorResult = {
        content: [{ type: "text", text: '{"error":"response lost after submission"}' }],
        isError: true,
        structuredContent: { error: "response lost after submission" },
      }
      claimOrGetAgentOperationMock.mockResolvedValueOnce({
        status: "NEW",
        operation: { id: "op-error" },
      })
      if (kind === "returned") callToolMock.mockResolvedValueOnce(errorResult)
      else callToolMock.mockRejectedValueOnce(new Error("response lost after submission"))
      const gate = makeRemoteApprovalGate({ apiKeyInfo, toolContext, connection })
      const args = { targetId: "target-1", mode: "STANDARD", idempotencyKey: "caller-outer-key" }
      const result = await gate("lyrashield_scan_target", args)

      expect(result).toMatchObject({
        approved: true,
        result: {
          isError: true,
          structuredContent: { operationId: "op-error" },
        },
      })
      expect(completeAgentOperationMock).not.toHaveBeenCalled()
      expect(failAgentOperationMock).toHaveBeenCalledWith(
        "op-error",
        "ws-1",
        expect.objectContaining({
          error: "OPERATION_OUTCOME_UNKNOWN",
          result: expect.objectContaining({
            isError: true,
            structuredContent: expect.objectContaining({ operationId: "op-error" }),
          }),
        })
      )
      claimOrGetAgentOperationMock.mockResolvedValueOnce({
        status: "FAILED",
        operation: { id: "op-error" },
      })
      expect(await gate("lyrashield_scan_target", args)).toMatchObject({ approved: false })
      expect(callToolMock).toHaveBeenCalledTimes(1)
    }
  )

  it("does not rerun after success when retaining the outer result fails", async () => {
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
      status: "NEW",
      operation: { id: "op-unretained" },
    })
    callToolMock.mockResolvedValueOnce({
      content: [],
      structuredContent: { scan: { id: "scan-persisted" } },
    })
    completeAgentOperationMock.mockRejectedValueOnce(new Error("Ledger write failed"))
    const gate = makeRemoteApprovalGate({ apiKeyInfo, toolContext, connection })
    const args = { targetId: "target-1", mode: "STANDARD", idempotencyKey: "same-action" }
    await expect(gate("lyrashield_scan_target", args)).rejects.toThrow("Ledger write failed")
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "IN_PROGRESS",
      operation: { id: "op-unretained", status: "EXECUTING" },
    })
    expect(await gate("lyrashield_scan_target", args)).toMatchObject({
      approved: true,
      result: {
        structuredContent: { operationId: "op-unretained", status: "EXECUTING" },
      },
    })
    expect(callToolMock).toHaveBeenCalledTimes(1)
    expect(failAgentOperationMock).not.toHaveBeenCalled()
  })

  it("uses a stable internal execution key while stripping caller control arguments from the input hash", async () => {
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "op-internal" },
    })
    callToolMock.mockResolvedValueOnce({ content: [], structuredContent: {} })
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
    await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "caller-outer-key",
    })
    expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { targetId: "target-1", mode: "STANDARD" },
        idempotencyKey: "caller-outer-key",
      })
    )
    expect(callToolMock).toHaveBeenCalledWith("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "op-internal",
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

    if (!result.approved || !result.result) throw new Error("Expected approved replay result")
    // The replay is the recorded result stamped with the durable operation
    // id — the id the MCP task layer binds `lst_<id>` to.
    expect(result.result.structuredContent).toEqual({
      scanId: "scan-999",
      operationId: "op-123",
    })
    expect(result.result.content[0]?.text).toContain('"operationId": "op-123"')
    // Tool was NOT re-executed
    expect(callToolMock).not.toHaveBeenCalled()
    expect(completeAgentOperationMock).not.toHaveBeenCalled()
  })

  it("denies a malformed stored result without re-executing the operation", async () => {
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
      status: "REPLAY",
      operation: { id: "op-corrupt", result: { foo: 1 } },
    })

    const result = await makeRemoteApprovalGate({ apiKeyInfo, connection, toolContext })(
      "lyrashield_scan_target",
      { targetId: "target-1", mode: "STANDARD", idempotencyKey: "idem-key-1" }
    )

    expect(result).toEqual({
      approved: false,
      reason: "The completed operation result is unavailable; the action will not be rerun.",
    })
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

  it("denies a changed input under the same idempotency key — real hashing, untouched ledger", async () => {
    // A minimal in-memory ledger that applies the REAL hashOperationInput so
    // this unit test exercises the same hash comparison the restricted-role
    // Postgres proof (remote-approval-gate.runtime.test.ts) runs against the
    // live ledger. Denial must leave the stored row — and the tool — untouched.
    const ledger = new Map<string, { inputHash: string; status: string }>()
    claimOrGetAgentOperationMock.mockImplementation(
      async (params: {
        connectionId?: string
        operationName: string
        idempotencyKey: string
        input: Record<string, unknown>
      }) => {
        const ledgerKey = `${params.connectionId}:${params.operationName}:${params.idempotencyKey}`
        const inputHash = realHashOperationInput(params.operationName, params.input)
        const existing = ledger.get(ledgerKey)
        if (existing) {
          return existing.inputHash === inputHash
            ? { status: "REPLAY", operation: { id: "op-hash-1", result: null } }
            : {
                status: "CONFLICT",
                message:
                  "Idempotency key was already used for this operation with different input arguments",
              }
        }
        ledger.set(ledgerKey, { inputHash, status: "EXECUTING" })
        return { status: "NEW", operation: { id: "op-hash-1" } }
      }
    )
    callToolMock.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"scanId":"scan-1"}' }],
      structuredContent: { scanId: "scan-1" },
    })

    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.create"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD", "DEEP"],
      expiresAt: null,
    }
    const gate = makeRemoteApprovalGate({ apiKeyInfo, connection, toolContext })

    const first = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      goal: "TEST_APP",
      idempotencyKey: "idem-hash-1",
    })
    expect(first.approved).toBe(true)
    // The stored hash is of the stripped tool input — the idempotencyKey
    // control arg is never part of the hashed operation input.
    const originalHash = realHashOperationInput("scan.create", {
      targetId: "target-1",
      mode: "STANDARD",
      goal: "TEST_APP",
    })
    expect(ledger.get("conn-1:scan.create:idem-hash-1")?.inputHash).toBe(originalHash)

    const second = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "DEEP",
      goal: "TEST_APP",
      idempotencyKey: "idem-hash-1",
    })

    expect(second).toMatchObject({
      approved: false,
      reason: expect.stringContaining("Idempotency conflict"),
    })
    // Ledger untouched and no tool action: the row still carries the first
    // input's hash, no completion/failure write occurred for the denied call.
    expect(ledger.get("conn-1:scan.create:idem-hash-1")?.inputHash).toBe(originalHash)
    expect(callToolMock).toHaveBeenCalledTimes(1)
    expect(completeAgentOperationMock).toHaveBeenCalledTimes(1)
    expect(failAgentOperationMock).not.toHaveBeenCalled()
  })

  it("requires an explicit scan.cancel grant — a scan.create grant alone does not authorize cancel", async () => {
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

    const gate = makeRemoteApprovalGate({ apiKeyInfo, connection, toolContext })
    const result = await gate("lyrashield_cancel_scan", {
      workspaceId: "ws-1",
      scanId: "scan-1",
      idempotencyKey: "cancel-1",
    })

    expect(result.approved).toBe(false)
    expect(result.reason).toContain("Update this connection's authorized workflows")
    expect(claimOrGetAgentOperationMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it("claims a durable scan.cancel operation when the connection grants it — no profile grant needed", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.cancel"],
      // A least-privilege grant scoped to the scan's own target, with no
      // billable profiles at all.
      allowedTargetIds: ["target-1"],
      allTargets: false,
      allowedProfiles: [],
      expiresAt: null,
    }
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "op-cancel" },
    })
    callToolMock.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"scan_cancel_requested"}' }],
      structuredContent: { action: "scan_cancel_requested" },
    })

    const gate = makeRemoteApprovalGate({ apiKeyInfo, connection, toolContext })
    const result = await gate("lyrashield_cancel_scan", {
      workspaceId: "ws-1",
      scanId: "scan-1",
      idempotencyKey: "cancel-1",
    })

    expect(result.approved).toBe(true)
    expect(requirePermissionMock).toHaveBeenCalledWith("ws-1", "scan:cancel")
    expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationName: "scan.cancel", idempotencyKey: "cancel-1" })
    )
  })

  it("requires an idempotency key for delegated scan cancellation", async () => {
    const connection = {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations: ["scan.cancel"],
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: [],
      expiresAt: null,
    }

    const gate = makeRemoteApprovalGate({ apiKeyInfo, connection, toolContext })
    const result = await gate("lyrashield_cancel_scan", {
      workspaceId: "ws-1",
      scanId: "scan-1",
    })

    expect(result).toMatchObject({ approved: false })
    expect(result.reason).toContain("idempotencyKey")
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

describe("makeRemoteApprovalGate - attachment + fix-PR tools (D2)", () => {
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

  function connectionWith(allowedOperations: string[]) {
    return {
      id: "conn-1",
      workspaceId: "ws-1",
      status: "ACTIVE" as const,
      authorizationVersion: 1,
      allowedOperations,
      allowedTargetIds: [],
      allTargets: true,
      allowedProfiles: ["STANDARD"],
      expiresAt: null,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    completeAgentOperationMock.mockResolvedValue({ status: "COMPLETED" })
    failAgentOperationMock.mockResolvedValue({ status: "FAILED" })
  })

  it("retains a scan reference returned with a tool error without completing the operation", async () => {
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "op-error-reference" },
    })
    callToolMock.mockResolvedValueOnce(
      McpToolResultSchema.parse({
        content: [
          { type: "text", text: '{"error":"response incomplete","scan":{"id":"scan-existing"}}' },
        ],
        isError: true,
        structuredContent: { error: "response incomplete", scan: { id: "scan-existing" } },
      })
    )
    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      toolContext,
      connection: connectionWith(["scan.create"]),
    })
    const decision = await gate("lyrashield_scan_target", {
      targetId: "target-1",
      mode: "STANDARD",
      idempotencyKey: "error-with-scan",
    })
    expect(decision).toMatchObject({
      approved: true,
      result: {
        isError: true,
        structuredContent: { scan: { id: "scan-existing" }, operationId: "op-error-reference" },
      },
    })
    expect(failAgentOperationMock).toHaveBeenCalledWith(
      "op-error-reference",
      "ws-1",
      expect.objectContaining({
        error: "OPERATION_OUTCOME_UNKNOWN",
        resultReference: "scan-existing",
        result: expect.objectContaining({ isError: true }),
      })
    )
    expect(completeAgentOperationMock).not.toHaveBeenCalled()
  })

  it.each(["IN_PROGRESS", "FAILED"])(
    "recovers a %s execution claim without invoking the handler",
    async (status) => {
      claimOrGetAgentOperationMock.mockResolvedValueOnce({
        status,
        operation: {
          id: "outer-op",
          status: status === "FAILED" ? "FAILED" : "EXECUTING",
          error: status === "FAILED" ? "OPERATION_OUTCOME_UNKNOWN" : null,
          result: null,
        },
      })
      const gate = makeRemoteApprovalGate({
        apiKeyInfo,
        toolContext,
        connection: connectionWith(["scan.create"]),
      })
      const before = Date.now()
      const decision = await gate("lyrashield_scan_target", {
        targetId: "target-1",
        mode: "STANDARD",
        idempotencyKey: "same-key",
      })
      expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
        expect.objectContaining({ staleExecutingBefore: expect.any(Date) })
      )
      const cutoff = claimOrGetAgentOperationMock.mock.calls[0]![0].staleExecutingBefore as Date
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 60 * 60_000)
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 60 * 60_000)
      expect(decision).toMatchObject({
        approved: true,
        result: { structuredContent: { operationId: "outer-op" } },
      })
      if (status === "FAILED")
        expect(decision).toMatchObject({
          result: {
            isError: true,
            structuredContent: {
              status: "FAILED",
              code: "OPERATION_OUTCOME_UNKNOWN",
            },
          },
        })
      expect(callToolMock).not.toHaveBeenCalled()
      expect(completeAgentOperationMock).not.toHaveBeenCalled()
      expect(failAgentOperationMock).not.toHaveBeenCalled()
    }
  )

  it("does not return late handler success after expiry won the finalization race", async () => {
    const original = new Date("2026-10-02T09:00:00Z")
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "expired-outer", updatedAt: original },
    })
    callToolMock.mockResolvedValueOnce({
      content: [],
      structuredContent: { scan: { id: "scan-existing" } },
    })
    completeAgentOperationMock.mockResolvedValueOnce({
      status: "FAILED",
      error: "OPERATION_OUTCOME_UNKNOWN",
      result: { content: [], structuredContent: { scan: { id: "scan-existing" } } },
    })
    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      toolContext,
      connection: connectionWith(["scan.create"]),
    })
    expect(
      await gate("lyrashield_scan_target", {
        targetId: "target-1",
        mode: "STANDARD",
        idempotencyKey: "same-key",
      })
    ).toMatchObject({
      approved: true,
      result: {
        isError: true,
        structuredContent: {
          status: "FAILED",
          code: "OPERATION_OUTCOME_UNKNOWN",
          operationId: "expired-outer",
        },
      },
    })
    expect(completeAgentOperationMock).toHaveBeenCalledWith(
      "expired-outer",
      "ws-1",
      expect.objectContaining({ expectedUpdatedAt: original })
    )
    expect(failAgentOperationMock).not.toHaveBeenCalled()
  })

  it("executes an attachment upload claim under an explicit scan_attachment.upload grant", async () => {
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "op-up" },
    })
    const toolResult = {
      content: [{ type: "text", text: '{"action":"scan_attachment_uploaded"}' }],
      structuredContent: { action: "scan_attachment_uploaded" },
    }
    callToolMock.mockResolvedValueOnce(toolResult)

    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection: connectionWith(["scan_attachment.upload"]),
      toolContext,
    })
    const result = await gate("lyrashield_upload_scan_attachment", {
      workspaceId: "ws-1",
      filename: "notes.txt",
      content: "hello",
      idempotencyKey: "up-1",
    })

    expect(result.approved).toBe(true)
    expect(requirePermissionMock).toHaveBeenCalledWith("ws-1", "attachment:upload")
    expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "scan_attachment.upload",
        idempotencyKey: "up-1",
        connectionId: "conn-1",
      })
    )
    expect(callToolMock).toHaveBeenCalledWith(
      "lyrashield_upload_scan_attachment",
      expect.objectContaining({ filename: "notes.txt", idempotencyKey: "op-up" })
    )
  })

  it("denies attachment upload on an old scan.create-only grant — grants are never widened", async () => {
    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection: connectionWith(["scan.create"]),
      toolContext,
    })
    const result = await gate("lyrashield_upload_scan_attachment", {
      workspaceId: "ws-1",
      filename: "notes.txt",
      content: "x",
      idempotencyKey: "up-1",
    })
    expect(result.approved).toBe(false)
    expect(claimOrGetAgentOperationMock).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it("denies attachment delete on a revoke-equivalent (empty operations) grant", async () => {
    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection: connectionWith([]),
      toolContext,
    })
    const result = await gate("lyrashield_delete_scan_attachment", {
      workspaceId: "ws-1",
      attachmentId: "att-1",
      idempotencyKey: "del-1",
    })
    expect(result.approved).toBe(false)
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it("executes a fix-PR request under fix_pr.create and resolves the proposal's stored target", async () => {
    claimOrGetAgentOperationMock.mockResolvedValueOnce({
      status: "NEW",
      operation: { id: "op-fix" },
    })
    const toolResult = {
      content: [{ type: "text", text: '{"action":"fix_pr_pending_approval"}' }],
      structuredContent: { action: "fix_pr_pending_approval" },
    }
    callToolMock.mockResolvedValueOnce(toolResult)

    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      // Target-scoped grant: the proposal's stored target must satisfy it.
      connection: {
        ...connectionWith(["fix_pr.create"]),
        allTargets: false,
        allowedTargetIds: ["target-1"],
      },
      toolContext,
    })
    const result = await gate("lyrashield_request_fix_pr", {
      workspaceId: "ws-1",
      proposalId: "prop-1",
      idempotencyKey: "fp-1",
    })

    expect(result.approved).toBe(true)
    expect(requirePermissionMock).toHaveBeenCalledWith("ws-1", "fix:create_pr")
    expect(claimOrGetAgentOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationName: "fix_pr.create", idempotencyKey: "fp-1" })
    )
  })

  it("denies a fix-PR request on a scan.create-only grant", async () => {
    const gate = makeRemoteApprovalGate({
      apiKeyInfo,
      connection: connectionWith(["scan.create"]),
      toolContext,
    })
    const result = await gate("lyrashield_request_fix_pr", {
      workspaceId: "ws-1",
      proposalId: "prop-1",
      idempotencyKey: "fp-1",
    })
    expect(result.approved).toBe(false)
    expect(callToolMock).not.toHaveBeenCalled()
  })
})
