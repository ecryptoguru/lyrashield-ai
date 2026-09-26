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
        fixProposal: { findFirst: vi.fn().mockResolvedValue({ findingId: "finding-1" }) },

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
      // The approved result carries the durable operation id stamp so the
      // MCP task layer can bind a task id to this exact ledger row.
      expect(result.result.structuredContent).toEqual({
        scanId: "scan-999",
        operationId: "op-123",
      })
      expect(result.result.content[0].text).toContain('"operationId": "op-123"')
    }
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
      // The replay is the recorded result stamped with the durable operation
      // id — the id the MCP task layer binds `lst_<id>` to.
      expect(result.result.structuredContent).toEqual({
        scanId: "scan-999",
        operationId: "op-123",
      })
      expect(result.result.content[0].text).toContain('"operationId": "op-123"')
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
      expect.objectContaining({ filename: "notes.txt" })
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
