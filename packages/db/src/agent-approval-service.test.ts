import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    auditLog: { create: vi.fn() },
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
  createApproval,
  findOrCreatePendingApproval,
  claimApprovalExecution,
  completeApprovalExecution,
  consumeApproval,
  denyApproval,
  expireStaleApprovals,
  failApprovalExecution,
  hashInput,
  listApprovals,
  MAX_APPROVAL_EXECUTION_ATTEMPTS,
  saveApprovalResult,
  verifyInputHash,
} from "./agent-approval-service"

const agentApproval = prisma.agentApproval as unknown as {
  findFirst: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  updateMany: ReturnType<typeof vi.fn>
}

function mockApprovalTransaction() {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "approval-1" }]),
    agentApproval: prisma.agentApproval,
  }
  vi.mocked(prisma.$transaction).mockImplementation(
    (fn: never) => (fn as (client: typeof tx) => unknown)(tx) as never
  )
  return tx
}

describe("Agent Approval Service — hash functions", () => {
  it("rejects JSON keys Prisma cannot safely persist before creating a record", async () => {
    vi.clearAllMocks()
    const input = JSON.parse('{"nested":[{"__proto__":{"forged":true}}]}')
    const params = { workspaceId: "workspace-1", actionName: "scan", input, requestedById: "u1" }
    await expect(createApproval(params)).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" })
    await expect(findOrCreatePendingApproval(params)).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
    })
    expect(prisma.agentApproval.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
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
  let tx: ReturnType<typeof mockApprovalTransaction>
  beforeEach(() => {
    vi.clearAllMocks()
    tx = mockApprovalTransaction()
  })

  it.each(["approve", "deny"] as const)(
    "cannot overwrite a concurrent decision or execution",
    async (decision) => {
      const input = { targetId: "target-1" }
      const inputHash = hashInput("scan", input)
      agentApproval.findFirst.mockResolvedValue({
        status: "PENDING",
        expiresAt: null,
        actionName: "scan",
        input,
        inputHash,
      })
      agentApproval.updateMany.mockResolvedValue({ count: 0 })
      const result =
        decision === "approve"
          ? approveApproval("approval-1", "workspace-1", "admin-1", inputHash)
          : denyApproval("approval-1", "workspace-1", "admin-1")
      await expect(result).rejects.toMatchObject({
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

  it("refuses a legacy approval whose stored input has a lossy hash", async () => {
    const input = JSON.parse('{"metadata":{"__proto__":{"forged":true}}}')
    const lossyHash = hashInput("connector.invoke", { metadata: {} })
    agentApproval.findFirst.mockResolvedValue({
      status: "PENDING",
      expiresAt: null,
      actionName: "connector.invoke",
      input,
      inputHash: lossyHash,
    })
    await expect(
      approveApproval("approval-1", "workspace-1", "admin-1", lossyHash)
    ).rejects.toMatchObject({ code: "INPUT_MISMATCH" })
    expect(agentApproval.updateMany).not.toHaveBeenCalled()
  })

  it("locks the reviewed row before validating and approving it", async () => {
    const input = { targetId: "target-1" }
    const inputHash = hashInput("scan", input)
    agentApproval.findFirst.mockResolvedValue({
      status: "PENDING",
      expiresAt: null,
      actionName: "scan",
      input,
      inputHash,
    })
    agentApproval.updateMany.mockResolvedValue({ count: 1 })
    await approveApproval("approval-1", "workspace-1", "admin-1", inputHash)
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      agentApproval.findFirst.mock.invocationCallOrder[0]!
    )
    expect(agentApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "approval-1", workspaceId: "workspace-1", inputHash }),
      })
    )
  })

  it("returns a stable typed code when an approval is missing", async () => {
    agentApproval.findFirst.mockResolvedValue(null)

    await expect(
      approveApproval("missing", "workspace-1", "admin-1", "hash")
    ).rejects.toMatchObject({
      name: "ApprovalMutationError",
      code: "NOT_FOUND",
    })
  })

  it("never reads or approves a row when no row was locked", async () => {
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(
      approveApproval("approval-1", "workspace-1", "admin-1", "hash")
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(agentApproval.findFirst).not.toHaveBeenCalled()
    expect(agentApproval.updateMany).not.toHaveBeenCalled()
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
    mockApprovalTransaction()
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
    const input = { fixProposalId: "proposal" }
    const inputHash = hashInput("fix_pr.open", input)
    agentApproval.findFirst.mockResolvedValue({
      status: "APPROVED",
      expiresAt: null,
      actionName: "fix_pr.open",
      input,
      inputHash,
    })
    agentApproval.updateMany.mockResolvedValue({ count: 1 })

    await expect(claimApprovalExecution("approval-1", "workspace-1", inputHash)).resolves.toBe(true)
    expect(agentApproval.updateMany).toHaveBeenCalledWith({
      where: {
        id: "approval-1",
        workspaceId: "workspace-1",
        status: "APPROVED",
        inputHash,
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      data: { status: "EXECUTING", attempts: { increment: 1 } },
    })
  })

  it("loses the claim when the row is not claimable (count 0)", async () => {
    const input = { fixProposalId: "proposal" }
    const inputHash = hashInput("fix_pr.open", input)
    agentApproval.findFirst.mockResolvedValue({
      status: "APPROVED",
      expiresAt: null,
      actionName: "fix_pr.open",
      input,
      inputHash,
    })
    agentApproval.updateMany.mockResolvedValue({ count: 0 })

    await expect(claimApprovalExecution("approval-1", "workspace-1", inputHash)).resolves.toBe(
      false
    )
  })

  it("does not claim a legacy approved row whose retained payload is not bound by its hash", async () => {
    const input = JSON.parse('{"metadata":{"__proto__":{"forged":true}}}')
    const inputHash = hashInput("fix_pr.open", { metadata: {} })
    agentApproval.findFirst.mockResolvedValue({
      status: "APPROVED",
      expiresAt: null,
      actionName: "fix_pr.open",
      input,
      inputHash,
    })
    await expect(claimApprovalExecution("approval-1", "workspace-1", inputHash)).resolves.toBe(
      false
    )
    expect(agentApproval.updateMany).not.toHaveBeenCalled()
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

describe("credential-authorized execution receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApprovalTransaction()
    vi.mocked(prisma.agentApproval.create).mockResolvedValue({
      id: "approval-1",
      status: "PENDING",
      actionName: "fix_pr.open",
      input: { patch: "hash" },
      inputHash: hashInput("fix_pr.open", { patch: "hash" }),
    } as never)
    vi.mocked(prisma.agentApproval.findFirst).mockResolvedValue({
      id: "approval-1",
      status: "PENDING",
      expiresAt: null,
      actionName: "fix_pr.open",
      input: { patch: "hash" },
      inputHash: hashInput("fix_pr.open", { patch: "hash" }),
    } as never)
    vi.mocked(prisma.agentApproval.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never)
  })
  const input = {
    workspaceId: "ws-1",
    actionName: "fix_pr.open",
    input: { patch: "hash" },
    requestedById: "user-1",
    authorization: { kind: "oauth-connection" as const, id: "connection-1" },
  }
  it("records credential provenance before enabling execution without claiming human review", async () => {
    expect((await createApproval(input)).status).toBe("APPROVED")
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "agent_action.connection_authorized",
          metadata: expect.objectContaining({ kind: "oauth-connection", id: "connection-1" }),
        }),
      })
    )
    expect(prisma.agentApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ inputHash: hashInput("fix_pr.open", input.input) }),
        data: { status: "APPROVED", approvedById: null, approvedAt: expect.any(Date) },
      })
    )
    expect(vi.mocked(prisma.auditLog.create).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prisma.agentApproval.updateMany).mock.invocationCallOrder[0]!
    )
  })
  it("leaves the receipt unexecutable when auditing fails", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error("audit unavailable"))
    await expect(createApproval(input)).rejects.toThrow("audit unavailable")
    expect(prisma.agentApproval.updateMany).not.toHaveBeenCalled()
  })
  it("does not approve a row that changes while audit is pending", async () => {
    vi.mocked(prisma.auditLog.create).mockImplementationOnce(async () => {
      vi.mocked(prisma.agentApproval.findFirst).mockResolvedValueOnce({
        id: "approval-1",
        status: "PENDING",
        expiresAt: null,
        actionName: "fix_pr.open",
        input: { patch: "changed" },
        inputHash: hashInput("fix_pr.open", input.input),
      } as never)
      return undefined as never
    })
    await expect(createApproval(input)).rejects.toMatchObject({ code: "INPUT_MISMATCH" })
    expect(prisma.agentApproval.updateMany).not.toHaveBeenCalled()
  })
})

describe("pending fix approval reuse", () => {
  it("serializes identical requests and replaces expired approvals", async () => {
    const existing: Array<{
      id: string
      expiresAt: Date
      actionName: string
      input: object
      inputHash: string
    }> = []
    let chain = Promise.resolve()
    const tx = {
      $executeRaw: vi.fn(),
      agentApproval: {
        findFirst: vi.fn(
          async ({ where }: { where: { OR: Array<{ expiresAt: { gt: Date } }> } }) =>
            existing.find((item) => item.expiresAt > where.OR[1]!.expiresAt.gt) ?? null
        ),
        create: vi.fn(
          async ({
            data,
          }: {
            data: { expiresAt: Date; actionName: string; input: object; inputHash: string }
          }) => {
            const row = { id: `approval-${existing.length + 1}`, ...data }
            existing.push(row)
            return row
          }
        ),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation((fn: never) => {
      const result = chain.then(() => (fn as (client: typeof tx) => unknown)(tx))
      chain = result.then(() => undefined)
      return result as never
    })
    const input = {
      workspaceId: "ws-1",
      actionName: "fix_pr.open",
      input: { fixProposalId: "p1" },
      requestedById: "u1",
      expiresAt: new Date(Date.now() + 60_000),
    }
    const [first, second] = await Promise.all([
      findOrCreatePendingApproval(input),
      findOrCreatePendingApproval(input),
    ])
    expect(first.id).toBe(second.id)
    expect(tx.agentApproval.create).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6)
    existing[0]!.expiresAt = new Date(0)
    expect((await findOrCreatePendingApproval(input)).id).not.toBe(first.id)
  })

  it("does not reuse a legacy pending row whose retained input has a lossy hash", async () => {
    const actionName = "fix_pr.open"
    const input = { fixProposalId: "p1" }
    const altered = JSON.parse('{"fixProposalId":"p1","__proto__":{"forged":true}}')
    const tx = {
      $executeRaw: vi.fn(),
      agentApproval: {
        findFirst: vi.fn().mockResolvedValue({
          id: "legacy",
          actionName,
          input: altered,
          inputHash: hashInput(actionName, input),
        }),
        create: vi.fn().mockResolvedValue({ id: "new" }),
      },
    }
    vi.mocked(prisma.$transaction).mockImplementation(
      (fn: never) => (fn as (client: typeof tx) => unknown)(tx) as never
    )
    const result = await findOrCreatePendingApproval({
      workspaceId: "ws-1",
      actionName,
      input,
      requestedById: "u1",
    })
    expect(result.id).toBe("new")
    expect(tx.agentApproval.create).toHaveBeenCalledOnce()
  })
})

describe("pending approval listing", () => {
  it("excludes expired and deadline-equal requests before applying the page limit", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-28T00:00:00Z"))
    const rows = [
      { id: "expired", expiresAt: new Date("2026-10-27T23:59:59Z") },
      { id: "deadline", expiresAt: new Date("2026-10-28T00:00:00Z") },
      { id: "valid", expiresAt: new Date("2026-10-28T00:01:00Z") },
      { id: "never", expiresAt: null },
    ]
    vi.mocked(prisma.agentApproval.findMany).mockImplementation(async (args) => {
      const where = args?.where as { OR?: Array<{ expiresAt: null | { gt: Date } }> }
      return rows
        .filter(
          (row) =>
            !where.OR ||
            where.OR.some((condition) =>
              condition.expiresAt === null
                ? row.expiresAt === null
                : row.expiresAt !== null && row.expiresAt > condition.expiresAt.gt
            )
        )
        .slice(0, args?.take ?? rows.length) as never
    })
    try {
      const result = await listApprovals({ workspaceId: "ws", status: "PENDING", limit: 2 })
      expect(result.items.map((row) => row.id)).toEqual(["valid", "never"])
      expect(result.nextCursor).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
