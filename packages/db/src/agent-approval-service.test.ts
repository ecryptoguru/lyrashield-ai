import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    agentApproval: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { prisma } from "./client"
import {
  approveApproval,
  claimApprovalExecution,
  completeApprovalExecution,
  consumeApproval,
  denyApproval,
  expireStaleApprovals,
  failApprovalExecution,
  hashInput,
  MAX_APPROVAL_EXECUTION_ATTEMPTS,
  saveApprovalResult,
  verifyInputHash,
} from "./agent-approval-service"

const agentApproval = prisma.agentApproval as unknown as {
  findFirst: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  updateMany: ReturnType<typeof vi.fn>
}

describe("Agent Approval Service — hash functions", () => {
  it("produces a deterministic SHA-256 hash", () => {
    const hash1 = hashInput("run-scan", { targetId: "t1", mode: "SAFE" })
    const hash2 = hashInput("run-scan", { targetId: "t1", mode: "SAFE" })
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)
  })

  it("produces different hashes for different actions", () => {
    const h1 = hashInput("run-scan", { targetId: "t1" })
    const h2 = hashInput("list-targets", { targetId: "t1" })
    expect(h1).not.toBe(h2)
  })

  it("produces different hashes for different inputs", () => {
    const h1 = hashInput("run-scan", { targetId: "t1" })
    const h2 = hashInput("run-scan", { targetId: "t2" })
    expect(h1).not.toBe(h2)
  })

  it("verifies matching input hash", () => {
    const hash = hashInput("run-scan", { targetId: "t1", mode: "DEEP" })
    expect(verifyInputHash("run-scan", { targetId: "t1", mode: "DEEP" }, hash)).toBe(true)
  })

  it("rejects mismatched input hash", () => {
    const hash = hashInput("run-scan", { targetId: "t1" })
    expect(verifyInputHash("run-scan", { targetId: "t2" }, hash)).toBe(false)
  })

  it("consumes only currently approved approvals", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 1 })
    await expect(consumeApproval("approval-1", "workspace-1")).resolves.toBe(true)
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "approval-1", workspaceId: "workspace-1", status: "APPROVED" },
      data: { status: "EXECUTED", executedAt: expect.any(Date) },
    })
    agentApproval.updateMany.mockResolvedValue({ count: 0 })
    await expect(consumeApproval("approval-1", "workspace-1")).resolves.toBe(false)
  })

  it("saves an approval result scoped to the right workspace", async () => {
    agentApproval.update.mockResolvedValue({ id: "approval-1" })
    await saveApprovalResult("approval-1", "workspace-1", { success: true })
    expect(agentApproval.update).toHaveBeenCalledWith({
      where: { id: "approval-1", workspaceId: "workspace-1" },
      data: { result: { success: true } },
    })
  })
})

describe("agent approval mutation errors", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([approveApproval, denyApproval])(
    "cannot overwrite a concurrent decision or execution",
    async (decide) => {
      agentApproval.findFirst.mockResolvedValue({ status: "PENDING", expiresAt: null })
      agentApproval.updateMany.mockResolvedValue({ count: 0 })
      await expect(decide("approval-1", "workspace-1", "admin-1")).rejects.toMatchObject({
        code: "NOT_PENDING",
      })
      expect(agentApproval.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "approval-1",
            workspaceId: "workspace-1",
            status: "PENDING",
          }),
        })
      )
      expect(agentApproval.update).not.toHaveBeenCalled()
    }
  )

  it("returns a stable typed code when an approval is missing", async () => {
    agentApproval.findFirst.mockResolvedValue(null)

    await expect(approveApproval("missing", "workspace-1", "admin-1")).rejects.toMatchObject({
      name: "ApprovalMutationError",
      code: "NOT_FOUND",
    })
  })

  it("returns a stable typed code instead of requiring message matching", async () => {
    agentApproval.findFirst.mockResolvedValue({ status: "APPROVED", expiresAt: null })

    await expect(denyApproval("approval-1", "workspace-1", "admin-1")).rejects.toMatchObject({
      name: "ApprovalMutationError",
      code: "NOT_PENDING",
    })
  })
})

describe("approval execution claim state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("never releases a possibly partial provider write for automatic retry", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 1 })
    expect(
      await failApprovalExecution("approval-1", "workspace-1", { error: "uncertain write" }, false)
    ).toBe("TERMINAL")
    expect(agentApproval.updateMany).toHaveBeenCalledOnce()
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "approval-1", workspaceId: "workspace-1", status: "EXECUTING" },
      data: { status: "EXECUTION_FAILED", result: { error: "uncertain write" } },
    })
  })

  it("claims only APPROVED, hash-matching, unexpired rows and increments attempts", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 1 })

    await expect(claimApprovalExecution("approval-1", "workspace-1", "hash-1")).resolves.toBe(true)
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: {
        id: "approval-1",
        workspaceId: "workspace-1",
        status: "APPROVED",
        inputHash: "hash-1",
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      data: { status: "EXECUTING", attempts: { increment: 1 } },
    })
  })

  it("loses the claim when the row is not claimable (count 0)", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 0 })

    await expect(claimApprovalExecution("approval-1", "workspace-1", "hash-1")).resolves.toBe(false)
  })

  it("completes only from EXECUTING and stores the winner's result", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 1 })

    const result = { content: [{ type: "text", text: "done" }], isError: false }
    await expect(completeApprovalExecution("approval-1", "workspace-1", result)).resolves.toBe(true)
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: { id: "approval-1", workspaceId: "workspace-1", status: "EXECUTING" },
      data: { status: "EXECUTED", executedAt: expect.any(Date), result },
    })

    agentApproval.updateMany.mockResolvedValue({ count: 0 })
    await expect(completeApprovalExecution("approval-1", "workspace-1", result)).resolves.toBe(
      false
    )
  })

  it("releases an in-budget failure back to APPROVED for retry", async () => {
    agentApproval.updateMany.mockResolvedValueOnce({ count: 1 })

    await expect(failApprovalExecution("approval-1", "workspace-1")).resolves.toBe("RETRYABLE")
    expect(agentApproval.updateMany).toHaveBeenCalledTimes(1)
    expect(agentApproval.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "approval-1",
        workspaceId: "workspace-1",
        status: "EXECUTING",
        attempts: { lt: MAX_APPROVAL_EXECUTION_ATTEMPTS },
      },
      data: { status: "APPROVED" },
    })
  })

  it("marks a past-budget failure terminally EXECUTION_FAILED and stores the error result", async () => {
    // Release misses (attempts at cap), then terminal transition wins.
    agentApproval.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

    const errorResult = { content: [{ type: "text", text: '{"error":"boom"}' }], isError: true }
    await expect(failApprovalExecution("approval-1", "workspace-1", errorResult)).resolves.toBe(
      "TERMINAL"
    )
    expect(agentApproval.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "approval-1", workspaceId: "workspace-1", status: "EXECUTING" },
      data: { status: "EXECUTION_FAILED", result: errorResult },
    })
  })

  it("expires stale PENDING and APPROVED rows without touching mid-flight EXECUTING claims", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 2 })

    await expect(expireStaleApprovals()).resolves.toBe(2)
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["PENDING", "APPROVED"] },
        expiresAt: { lt: expect.any(Date) },
      },
      data: { status: "EXPIRED" },
    })
  })

  it("scopes the expiry sweep to one workspace when given", async () => {
    agentApproval.updateMany.mockResolvedValue({ count: 0 })

    await expireStaleApprovals("workspace-7")
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["PENDING", "APPROVED"] },
        expiresAt: { lt: expect.any(Date) },
        workspaceId: "workspace-7",
      },
      data: { status: "EXPIRED" },
    })
  })
})
