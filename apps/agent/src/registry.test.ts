import { describe, it, expect, beforeEach, vi } from "vitest"
import type { AgentActionDefinition, AgentActionContext } from "@lyrashield/types"
import { z } from "zod"

vi.mock("@lyrashield/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
  },
  createApproval: vi.fn(),
  consumeApproval: vi.fn(),
  getApproval: vi.fn(),
  saveApprovalResult: vi.fn(),
  setWorkspaceContext: vi.fn(),
  verifyInputHash: vi.fn(() => true),
}))

vi.mock("@lyrashield/auth", () => ({
  hasPermission: vi.fn((role: string, _perm: string) => role === "ADMIN"),
  PERMISSIONS: { agent: { view: "agent:view", act: "agent:act", approve: "agent:approve" } },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { ActionRegistry } from "./registry"

function createContext(role = "ADMIN"): AgentActionContext {
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    role,
  }
}

function makeTestAction(overrides: Partial<AgentActionDefinition> = {}): AgentActionDefinition {
  return {
    name: "test-action",
    description: "Test action",
    inputSchema: z.object({ value: z.string() }) as unknown as AgentActionDefinition["inputSchema"],
    permission: "agent:view",
    auditAction: "test.action",
    auditResourceType: "test",
    handler: async (input) => ({ result: (input as { value: string }).value }),
    ...overrides,
  }
}

describe("ActionRegistry", () => {
  let registry: ActionRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new ActionRegistry()
  })

  it("registers and lists actions", () => {
    registry.register(makeTestAction())
    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe("test-action")
  })

  it("throws on duplicate registration", () => {
    registry.register(makeTestAction())
    expect(() => registry.register(makeTestAction())).toThrow("already registered")
  })

  it("returns unknown action error for unregistered action", async () => {
    const result = await registry.execute("nonexistent", {}, createContext())
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("UNKNOWN_ACTION")
  })

  it("validates input with Zod", async () => {
    registry.register(makeTestAction())
    const result = await registry.execute("test-action", { value: 123 }, createContext())
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("VALIDATION_ERROR")
  })

  it("rejects input that names a different workspace than the authenticated context", async () => {
    let called = false
    registry.register(
      makeTestAction({
        inputSchema: z.object({
          workspaceId: z.string(),
          value: z.string(),
        }) as unknown as AgentActionDefinition["inputSchema"],
        handler: async () => {
          called = true
          return { result: "unexpected" }
        },
      })
    )

    const result = await registry.execute(
      "test-action",
      { workspaceId: "ws-other", value: "ok" },
      createContext()
    )

    expect(result).toEqual({
      success: false,
      error: {
        code: "WORKSPACE_MISMATCH",
        message: "Action input must use the authenticated workspace",
      },
    })
    expect(called).toBe(false)
  })

  it("denies action when permission is insufficient", async () => {
    registry.register(makeTestAction({ permission: "agent:approve" }))
    const result = await registry.execute("test-action", { value: "ok" }, createContext("MEMBER"))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("FORBIDDEN")
  })

  it("executes action successfully with valid input and permission", async () => {
    registry.register(makeTestAction())
    const result = await registry.execute("test-action", { value: "hello" }, createContext("ADMIN"))
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ result: "hello" })
  })

  it("creates approval request when needsApproval returns true", async () => {
    const { createApproval } = await import("@lyrashield/db")
    vi.mocked(createApproval).mockResolvedValue({
      id: "approval-1",
      workspaceId: "ws-1",
      actionName: "test-action",
      inputHash: "hash",
      status: "PENDING",
      input: {},
      requestedById: "user-1",
      approvedById: null,
      approvedAt: null,
      deniedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    registry.register(
      makeTestAction({
        needsApproval: () => true,
      })
    )
    const result = await registry.execute("test-action", { value: "hello" }, createContext("ADMIN"))
    expect(result.success).toBe(false)
    expect(result.needsApproval).toBe(true)
    expect(result.approvalId).toBe("approval-1")
    expect(result.error?.code).toBe("NEEDS_APPROVAL")
  })

  it("handles handler errors gracefully", async () => {
    registry.register(
      makeTestAction({
        handler: async () => {
          throw new Error("Handler failed")
        },
      })
    )
    const result = await registry.execute("test-action", { value: "ok" }, createContext("ADMIN"))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("EXECUTION_ERROR")
    expect(result.error?.message).toBe("Handler failed")
  })

  it("returns success even if audit log fails", async () => {
    const { prisma } = await import("@lyrashield/db")
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error("DB connection lost"))

    registry.register(makeTestAction())
    const result = await registry.execute("test-action", { value: "ok" }, createContext("ADMIN"))
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ result: "ok" })
  })

  it("rejects approved action when actionName does not match approval", async () => {
    const { getApproval } = await import("@lyrashield/db")
    vi.mocked(getApproval).mockResolvedValueOnce({
      id: "approval-1",
      workspaceId: "ws-1",
      actionName: "different-action",
      inputHash: "hash",
      status: "APPROVED",
      input: {},
      requestedById: "user-1",
      approvedById: "user-2",
      approvedAt: new Date(),
      deniedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    registry.register(makeTestAction())
    const result = await registry.execute(
      "test-action",
      { value: "ok" },
      { ...createContext("ADMIN"), approvalId: "approval-1" }
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("APPROVAL_MISMATCH")
  })

  it("rejects approved action when input hash does not match", async () => {
    const { getApproval, verifyInputHash } = await import("@lyrashield/db")
    vi.mocked(getApproval).mockResolvedValueOnce({
      id: "approval-1",
      workspaceId: "ws-1",
      actionName: "test-action",
      inputHash: "hash",
      status: "APPROVED",
      input: {},
      requestedById: "user-1",
      approvedById: "user-2",
      approvedAt: new Date(),
      deniedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    vi.mocked(verifyInputHash).mockReturnValueOnce(false)

    registry.register(makeTestAction())
    const result = await registry.execute(
      "test-action",
      { value: "ok" },
      { ...createContext("ADMIN"), approvalId: "approval-1" }
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("APPROVAL_INPUT_MISMATCH")
  })

  it("spends approvals atomically so they cannot be replayed", async () => {
    const { consumeApproval, getApproval, saveApprovalResult } = await import("@lyrashield/db")
    vi.mocked(getApproval).mockResolvedValue({
      id: "approval-1",
      workspaceId: "ws-1",
      actionName: "test-action",
      inputHash: "hash",
      status: "APPROVED",
      input: {},
      requestedById: "user-1",
      approvedById: "user-2",
      approvedAt: new Date(),
      deniedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    vi.mocked(consumeApproval).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    registry.register(makeTestAction())
    const context = { ...createContext("ADMIN"), approvalId: "approval-1" }
    expect((await registry.execute("test-action", { value: "ok" }, context)).success).toBe(true)
    expect((await registry.execute("test-action", { value: "ok" }, context)).error?.code).toBe(
      "APPROVAL_ALREADY_USED"
    )
    expect(saveApprovalResult).toHaveBeenCalledWith("approval-1", { success: true })
  })

  it("allows only one of two concurrent approval executions", async () => {
    const { consumeApproval, getApproval } = await import("@lyrashield/db")
    vi.mocked(getApproval).mockResolvedValue({
      id: "approval-1",
      workspaceId: "ws-1",
      actionName: "test-action",
      inputHash: "hash",
      status: "APPROVED",
      input: {},
      requestedById: "user-1",
      approvedById: "user-2",
      approvedAt: new Date(),
      deniedAt: null,
      executedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    vi.mocked(consumeApproval).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    registry.register(makeTestAction())
    const context = { ...createContext("ADMIN"), approvalId: "approval-1" }
    const results = await Promise.all([
      registry.execute("test-action", { value: "ok" }, context),
      registry.execute("test-action", { value: "ok" }, context),
    ])
    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(results.find((result) => result.error?.code === "APPROVAL_ALREADY_USED")).toBeTruthy()
  })

  it("reports a previously executed approval as already used", async () => {
    const { consumeApproval, getApproval } = await import("@lyrashield/db")
    vi.mocked(getApproval).mockResolvedValue({
      id: "approval-1",
      workspaceId: "ws-1",
      actionName: "test-action",
      inputHash: "hash",
      status: "EXECUTED",
      input: {},
      requestedById: "user-1",
      approvedById: "user-2",
      approvedAt: new Date(),
      deniedAt: null,
      executedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    registry.register(makeTestAction())
    const result = await registry.execute(
      "test-action",
      { value: "ok" },
      {
        ...createContext("ADMIN"),
        approvalId: "approval-1",
      }
    )
    expect(result.error?.code).toBe("APPROVAL_ALREADY_USED")
    expect(consumeApproval).not.toHaveBeenCalled()
  })
})
