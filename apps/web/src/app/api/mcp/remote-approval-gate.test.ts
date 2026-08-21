import { beforeEach, describe, expect, it, vi } from "vitest"

const dbGetApproval = vi.fn()
const dbClaimApprovalExecution = vi.fn()
const dbCompleteApprovalExecution = vi.fn()
const dbFailApprovalExecution = vi.fn()

vi.mock("@lyrashield/db", () => ({
  getApproval: (...a: unknown[]) => dbGetApproval(...a),
  claimApprovalExecution: (...a: unknown[]) => dbClaimApprovalExecution(...a),
  completeApprovalExecution: (...a: unknown[]) => dbCompleteApprovalExecution(...a),
  failApprovalExecution: (...a: unknown[]) => dbFailApprovalExecution(...a),
  createApproval: vi.fn(),
  findPendingApprovalByHash: vi.fn(),
  hashInput: vi.fn(() => "hashed"),
  verifyInputHash: vi.fn(() => true),
}))

const mcpCallTool = vi.fn()
vi.mock("@lyrashield/mcp", () => ({
  McpServer: class {
    callTool = (...a: Parameters<typeof mcpCallTool>) => mcpCallTool(...(a as []))
  },
}))

vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("../../../lib/rate-limit", () => ({
  checkApprovalCreateRateLimit: vi.fn(() => ({ limited: false })),
}))

import { makeRemoteApprovalGate } from "./remote-approval-gate"
import { verifyInputHash } from "@lyrashield/db"

const TOOL_RESULT = {
  content: [{ type: "text", text: '{"ok":true}' }],
  isError: false,
}

function approvalFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ap-1",
    workspaceId: "ws-1",
    actionName: "run-scan",
    inputHash: "hash-ap-1",
    status: "APPROVED",
    input: {},
    requestedById: "user-1",
    approvedById: "admin-1",
    approvedAt: new Date(),
    deniedAt: null,
    executedAt: null,
    expiresAt: null,
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeGate() {
  return makeRemoteApprovalGate({
    apiKeyInfo: {
      workspaceId: "ws-1",
      scopes: ["write"],
      createdById: "user-1",
      keyId: "key-1",
    },
    toolContext: { apiBaseUrl: "https://app.example.com", apiKey: "lsk_test" },
  })
}

describe("remote approval gate — claim-before-execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(verifyInputHash as ReturnType<typeof vi.fn>).mockReturnValue(true)
    dbGetApproval.mockResolvedValue(approvalFixture())
    dbClaimApprovalExecution.mockResolvedValue(true)
    dbCompleteApprovalExecution.mockResolvedValue(true)
    dbFailApprovalExecution.mockResolvedValue("RETRYABLE")
    mcpCallTool.mockResolvedValue(TOOL_RESULT)
  })

  it("two concurrent polls execute the tool exactly once; loser replays the winner's result", async () => {
    // Simulate the DB's atomic claim: only the first caller transitions the row.
    dbClaimApprovalExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    // First read per caller sees APPROVED; the loser's post-loss re-read sees EXECUTED.
    dbGetApproval
      .mockResolvedValueOnce(approvalFixture())
      .mockResolvedValueOnce(approvalFixture())
      .mockResolvedValue(
        approvalFixture({
          status: "EXECUTED",
          executedAt: new Date(),
          result: { content: TOOL_RESULT.content, isError: false },
        })
      )

    const gate = makeGate()
    const [a, b] = await Promise.all([
      gate("run-scan", { targetId: "t-1", approvalId: "ap-1" }),
      gate("run-scan", { targetId: "t-1", approvalId: "ap-1" }),
    ])

    expect(mcpCallTool).toHaveBeenCalledTimes(1)
    expect(a.approved).toBe(true)
    expect(b.approved).toBe(true)

    const aResult = (a as { result?: { content?: unknown[] } }).result
    const bResult = (b as { result?: { content?: unknown[] } }).result
    expect(bResult?.content).toEqual(aResult?.content)
  })

  it("a mismatched input hash is denied and never claims", async () => {
    ;(verifyInputHash as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-EVIL", approvalId: "ap-1" })

    expect(decision.approved).toBe(false)
    expect((decision as { reason: string }).reason).toMatch(/does not match/)
    expect(dbClaimApprovalExecution).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("an expired approval never executes even when raced", async () => {
    dbGetApproval.mockResolvedValue(approvalFixture({ expiresAt: new Date(Date.now() - 1000) }))
    // Even if a concurrent claim somehow raced past the pre-check, the
    // expiry predicate inside the claim rejects it.
    dbClaimApprovalExecution.mockResolvedValue(false)

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })

    expect(decision.approved).toBe(false)
    expect((decision as { reason: string }).reason).toMatch(/expired/i)
    expect(dbClaimApprovalExecution).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("a claim lost to expiry mid-flight falls back to pending, never execution", async () => {
    dbGetApproval.mockResolvedValue(approvalFixture({ expiresAt: new Date(Date.now() + 1) }))
    dbClaimApprovalExecution.mockResolvedValue(false) // expired inside the claim predicate
    dbGetApproval.mockResolvedValueOnce(approvalFixture()) // pre-check read

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })

    expect(decision.approved).toBe(false)
    expect(dbCompleteApprovalExecution).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("replays a stored EXECUTED result identically without touching the tool", async () => {
    const stored = approvalFixture({
      status: "EXECUTED",
      executedAt: new Date(),
      result: { content: [{ type: "text", text: "prior-run" }], isError: true },
    })
    dbGetApproval.mockResolvedValue(stored)

    const gate = makeGate()
    const first = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })
    const second = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })

    expect(first).toEqual(second)
    expect(first.approved).toBe(true)
    expect((first as { result?: { isError?: boolean } }).result?.isError).toBe(true)
    expect(mcpCallTool).not.toHaveBeenCalled()
    expect(dbClaimApprovalExecution).not.toHaveBeenCalled()
  })

  it("returns RETRYABLE failure to pending so the next poll retries within budget", async () => {
    mcpCallTool.mockRejectedValue(new Error("upstream timeout"))

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })

    expect(decision.approved).toBe(false)
    expect((decision as { pending?: boolean }).pending).toBe(true)
    expect(dbFailApprovalExecution).toHaveBeenCalledWith("ap-1", "ws-1", expect.any(Object))
    expect(dbCompleteApprovalExecution).not.toHaveBeenCalled()
    expect(mcpCallTool).toHaveBeenCalledTimes(1)
  })

  it("a terminal EXECUTION_FAILED failure is denied closed", async () => {
    mcpCallTool.mockRejectedValue(new Error("upstream timeout"))
    dbFailApprovalExecution.mockResolvedValue("TERMINAL")

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })

    expect(decision.approved).toBe(false)
    expect((decision as { reason: string }).reason).toMatch(/failed/i)
    expect(dbFailApprovalExecution).toHaveBeenCalledWith("ap-1", "ws-1", expect.any(Object))
    expect(mcpCallTool).toHaveBeenCalledTimes(1)
  })

  it("cross-workspace approval IDs fail closed and never claim", async () => {
    dbGetApproval.mockResolvedValue(null) // scoped lookup misses foreign-workspace rows

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-1", approvalId: "ap-foreign" })

    expect(decision.approved).toBe(false)
    expect((decision as { reason: string }).reason).toMatch(/not found/i)
    expect(dbClaimApprovalExecution).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })

  it("still holds PENDING approvals for out-of-band human approval", async () => {
    dbGetApproval.mockResolvedValue(approvalFixture({ status: "PENDING" }))

    const gate = makeGate()
    const decision = await gate("run-scan", { targetId: "t-1", approvalId: "ap-1" })

    expect(decision.approved).toBe(false)
    expect((decision as { pending?: boolean }).pending).toBe(true)
    expect(dbClaimApprovalExecution).not.toHaveBeenCalled()
    expect(mcpCallTool).not.toHaveBeenCalled()
  })
})
