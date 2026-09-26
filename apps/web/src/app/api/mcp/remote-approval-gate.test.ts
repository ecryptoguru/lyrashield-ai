import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermissionMock = vi.fn().mockResolvedValue({})
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
  },
  createApproval: (...a: unknown[]) => createApprovalMock(...a),
  findPendingApprovalByHash: (...a: unknown[]) => findPendingApprovalByHashMock(...a),
  getApproval: (...a: unknown[]) => getApprovalMock(...a),
  claimApprovalExecution: (...a: unknown[]) => claimApprovalExecutionMock(...a),
  completeApprovalExecution: vi.fn(),
  failApprovalExecution: vi.fn(),
  hashInput: vi.fn(() => "hashed"),
  verifyInputHash: vi.fn(() => true),
  withWorkspaceRLS: vi.fn(),
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

function makeGate(scopes: string[] = ["write"]) {
  return makeRemoteApprovalGate({
    apiKeyInfo: {
      workspaceId: "ws-1",
      scopes,
      createdById: "user-1",
      keyId: "key-1",
    },
    toolContext: { apiBaseUrl: "https://app.example.com", apiKey: "lsk_test" },
  })
}

describe("remote approval gate — connect-over-OAuth only", () => {
  beforeEach(() => vi.clearAllMocks())

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
      workspaceId: "ws-1",
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
})
