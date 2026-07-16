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
  consumeApproval,
  denyApproval,
  hashInput,
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
})

describe("agent approval mutation errors", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
