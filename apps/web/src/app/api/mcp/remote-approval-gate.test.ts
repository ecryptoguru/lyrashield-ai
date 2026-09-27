import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermissionMock = vi.fn().mockResolvedValue({})
const withWorkspaceRLSMock = vi.fn()
const checkDelegatedOperationAuthorizationMock = vi.fn()
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
}))

const createApprovalMock = vi.fn()
const findPendingApprovalByHashMock = vi.fn()
const getApprovalMock = vi.fn()
const claimApprovalExecutionMock = vi.fn()

vi.mock("@lyrashield/db", () => ({
  TOOL_OPERATION_MAP: {
    lyrashield_scan_target: { canonicalOperation: "scan.create" },
    lyrashield_create_report: { canonicalOperation: "report.create" },
    lyrashield_cancel_scan: { canonicalOperation: "scan.cancel" },
    lyrashield_upload_scan_attachment: { canonicalOperation: "scan_attachment.upload" },
  },
  checkDelegatedOperationAuthorization: (...args: unknown[]) =>
    checkDelegatedOperationAuthorizationMock(...args),
  createApproval: (...a: unknown[]) => createApprovalMock(...a),
  findPendingApprovalByHash: (...a: unknown[]) => findPendingApprovalByHashMock(...a),
  getApproval: (...a: unknown[]) => getApprovalMock(...a),
  claimApprovalExecution: (...a: unknown[]) => claimApprovalExecutionMock(...a),
  completeApprovalExecution: vi.fn(),
  failApprovalExecution: vi.fn(),
  hashInput: vi.fn(() => "hashed"),
  verifyInputHash: vi.fn(() => true),
  withWorkspaceRLS: (...args: unknown[]) => withWorkspaceRLSMock(...args),
}))

const mcpCallTool = vi.fn()
vi.mock("@lyrashield/mcp", () => ({
  McpServer: class {
    callTool = (...a: Parameters<typeof mcpCallTool>) => mcpCallTool(...(a as []))
  },
}))

vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { makeRemoteApprovalGate } from "./remote-approval-gate"

function makeGate(
  scopes: string[] = ["write"],
  connection?: {
    id: string
    workspaceId: string
    status: "ACTIVE"
    authorizationVersion: number
    allowedOperations: string[]
    allowedTargetIds: string[]
    allTargets: boolean
    allowedProfiles: string[]
    expiresAt: Date | null
  }
) {
  return makeRemoteApprovalGate({
    apiKeyInfo: {
      workspaceId: "ws-1",
      scopes,
      createdById: "user-1",
      keyId: "key-1",
    },
    connection,
    toolContext: { apiBaseUrl: "https://app.example.com", apiKey: "lsk_test" },
  })
}

describe("remote approval gate — connect-over-OAuth only", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const scanFindFirst = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === "scan-1" ? { targetId: "target-b", mode: "STANDARD" } : null
      )
    withWorkspaceRLSMock.mockImplementation(async (_workspaceId, callback) =>
      callback({
        scan: { findFirst: scanFindFirst },
        finding: { findFirst: vi.fn() },
        fixProposal: { findFirst: vi.fn() },
        target: { findFirst: vi.fn() },
      })
    )
    checkDelegatedOperationAuthorizationMock.mockImplementation(({ connection, targetId }) => ({
      authorized: connection.allTargets || connection.allowedTargetIds.includes(targetId),
      canonicalOperation: "scan.cancel",
      reason: "This operation is outside the delegated target scope",
    }))
  })

  const targetAConnection = {
    id: "conn-1",
    workspaceId: "ws-1",
    status: "ACTIVE" as const,
    authorizationVersion: 1,
    allowedOperations: ["scan.cancel"],
    allowedTargetIds: ["target-a"],
    allTargets: false,
    allowedProfiles: ["STANDARD"],
    expiresAt: null,
  }

  it("returns one structured connect_required response for a write-scoped key", async () => {
    const decision = await makeGate()("lyrashield_scan_target", {
      targetId: "t-1",
      workspaceId: "ws-1",
    })

    expect(decision.approved).toBe(false)
    expect(decision.structuredContent).toMatchObject({
      code: "connect_required",
      connectUrl: "https://app.example.com/dashboard/connections",
      docsUrl: "https://lyrashieldai.com/docs/approvals",
    })
    expect(decision.reason).toBe(decision.structuredContent?.message)
  })

  it("creates no AgentApproval row and executes nothing", async () => {
    await makeGate()("lyrashield_scan_target", { targetId: "t-1", workspaceId: "ws-1" })

    expect(createApprovalMock).not.toHaveBeenCalled()
    expect(findPendingApprovalByHashMock).not.toHaveBeenCalled()
    expect(getApprovalMock).not.toHaveBeenCalled()
    expect(claimApprovalExecutionMock).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("returns connect_required even when a legacy approvalId is supplied", async () => {
    const decision = await makeGate()("lyrashield_scan_target", {
      targetId: "t-1",
      approvalId: "ap-legacy",
    })

    expect(decision.approved).toBe(false)
    expect(decision.structuredContent?.code).toBe("connect_required")
    expect(getApprovalMock).not.toHaveBeenCalled()
  })

  it("denies read-only credentials on scope before any connect hint", async () => {
    const decision = await makeGate(["read"])("lyrashield_scan_target", {
      targetId: "t-1",
      workspaceId: "ws-1",
    })

    expect(decision).toEqual({
      approved: false,
      reason: "This connection does not have write scope; mutating tools are refused.",
    })
    expect(createApprovalMock).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("denies tools with no supported permission binding", async () => {
    const decision = await makeGate()("lyrashield_unknown_tool", { workspaceId: "ws-1" })
    expect(decision).toEqual({
      approved: false,
      reason: "This operation has no supported permission binding.",
    })
  })

  it("denies when current workspace access no longer authorizes the operation", async () => {
    requirePermissionMock.mockRejectedValueOnce(new Error("FORBIDDEN"))
    const decision = await makeGate()("lyrashield_scan_target", {
      targetId: "t-1",
      workspaceId: "ws-1",
    })
    expect(decision).toEqual({
      approved: false,
      reason: "Current workspace access does not authorize this operation.",
    })
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("resolves a cancellation target from the scan instead of trusting the caller", async () => {
    const decision = await makeGate(["write"], targetAConnection)("lyrashield_cancel_scan", {
      workspaceId: "ws-1",
      scanId: "scan-1",
      idempotencyKey: "cancel-1",
    })

    expect(decision.approved).toBe(false)
    expect(checkDelegatedOperationAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "target-b" })
    )
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("denies a targetId that conflicts with the referenced scan", async () => {
    const decision = await makeGate(["write"], targetAConnection)("lyrashield_cancel_scan", {
      workspaceId: "ws-1",
      scanId: "scan-1",
      targetId: "target-a",
      idempotencyKey: "cancel-1",
    })

    expect(decision.approved).toBe(false)
    expect(checkDelegatedOperationAuthorizationMock).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("fails closed when a referenced scan cannot be resolved, including all-target grants", async () => {
    const connection = { ...targetAConnection, allTargets: true }
    withWorkspaceRLSMock.mockImplementationOnce(async (_workspaceId, callback) =>
      callback({
        scan: { findFirst: vi.fn().mockResolvedValue(null) },
        finding: { findFirst: vi.fn() },
        fixProposal: { findFirst: vi.fn() },
        target: { findFirst: vi.fn() },
      })
    )

    const decision = await makeGate(["write"], connection)("lyrashield_cancel_scan", {
      workspaceId: "ws-1",
      scanId: "missing",
      idempotencyKey: "cancel-1",
    })

    expect(decision.approved).toBe(false)
    expect(checkDelegatedOperationAuthorizationMock).not.toHaveBeenCalled()
  })

  it("requires allTargets for a workspace-level attachment operation", async () => {
    const decision = await makeGate(["write"], {
      ...targetAConnection,
      allowedOperations: ["scan_attachment.upload"],
    })("lyrashield_upload_scan_attachment", {
      workspaceId: "ws-1",
      targetId: "target-a",
      idempotencyKey: "upload-1",
    })

    expect(decision.approved).toBe(false)
    expect(checkDelegatedOperationAuthorizationMock).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })
})
