import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    loopClosure: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    notification: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}))

vi.mock("./system-client", () => ({
  getSystemPrisma: () => prisma,
}))

vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(prisma)
  ),
}))

vi.mock("./notification-service", () => ({
  createNotification: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { prisma } from "./client"
import { createNotification } from "./notification-service"
import { Prisma } from "./generated/prisma"
import {
  LOOP_CLOSURE_MAX_ATTEMPTS,
  LOOP_CLOSURE_BACKOFF_MINUTES,
  classifyLoopClosureError,
  nextLoopClosureRetryAt,
  recordDeferredLoopClosure,
  completeLoopClosure,
  failLoopClosureTerminally,
  claimDueLoopClosures,
} from "./loop-closure-service"

const mockPrisma = prisma as unknown as {
  loopClosure: {
    create: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
  }
}

describe("classifyLoopClosureError", () => {
  it("classifies each real deferral cause by its structured identity", () => {
    class WorkspaceScanConcurrencyLimitError extends Error {}
    class ScanWorkerUnavailableError extends Error {
      readonly code = "SCAN_SERVICE_UNAVAILABLE"
    }
    const concurrency = new WorkspaceScanConcurrencyLimitError(
      "Workspace already has 2 active scans"
    )
    const worker = new ScanWorkerUnavailableError()
    const activeScan = new Error("Target already has an active scan")
    const entitlement = new Error("NO_MINUTES_REMAINING")
    const entitlementFallback = new Error("RETEST_NOT_ENTITLED")
    const unexpected = new Error("prisma engine crashed")

    expect(classifyLoopClosureError(concurrency)).toBe("SCAN_CONCURRENCY_LIMIT")
    expect(classifyLoopClosureError(worker)).toBe("WORKER_UNAVAILABLE")
    expect(classifyLoopClosureError(activeScan)).toBe("ACTIVE_SCAN_ON_TARGET")
    expect(classifyLoopClosureError(entitlement)).toBe("RETEST_NOT_ENTITLED")
    expect(classifyLoopClosureError(entitlementFallback)).toBe("RETEST_NOT_ENTITLED")
    expect(classifyLoopClosureError(unexpected)).toBe("UNEXPECTED_ERROR")
  })
})

describe("recordDeferredLoopClosure", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.loopClosure.create.mockResolvedValue({ id: "closure-1" })
    mockPrisma.loopClosure.updateMany.mockResolvedValue({ count: 1 })
  })

  it("persists a durable pending record with backoff", async () => {
    await recordDeferredLoopClosure({
      workspaceId: "ws-1",
      repoFullName: "acme/repo",
      branchName: "lyrashield/fix-abc",
      prNumber: 42,
      reason: "SCAN_CONCURRENCY_LIMIT",
    })
    const call = mockPrisma.loopClosure.create.mock.calls[0][0]
    expect(call.data).toMatchObject({ status: "pending", attempts: 1 })
    expect(call.data.lastReason).toBe("SCAN_CONCURRENCY_LIMIT")
    // First backoff step is 1 minute from now.
    expect(call.data.nextRetryAt.getTime()).toBeGreaterThan(Date.now())
  })

  it("sets attempts absolutely so the sweep and webhook agree on the count", async () => {
    await recordDeferredLoopClosure({
      workspaceId: "ws-1",
      repoFullName: "acme/repo",
      branchName: "lyrashield/fix-abc",
      prNumber: 42,
      reason: "WORKER_UNAVAILABLE",
      attempts: 3,
    })
    const call = mockPrisma.loopClosure.create.mock.calls[0][0]
    expect(call.data.attempts).toBe(3)
  })

  it("never creates a second row for a duplicate delivery (unique race path)", async () => {
    mockPrisma.loopClosure.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
      })
    )
    await expect(
      recordDeferredLoopClosure({
        workspaceId: "ws-1",
        repoFullName: "acme/repo",
        branchName: "lyrashield/fix-abc",
        prNumber: 42,
        reason: "WORKER_UNAVAILABLE",
      })
    ).resolves.toBeUndefined()
    expect(mockPrisma.loopClosure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "pending" }),
        data: expect.not.objectContaining({
          attempts: expect.anything(),
          status: expect.anything(),
        }),
      })
    )
  })
})

describe("failLoopClosureTerminally", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.loopClosure.updateMany.mockResolvedValue({ count: 1 })
    vi.mocked(createNotification).mockResolvedValue({ id: "notif-1" } as never)
  })

  it("marks the closure failed and notifies the workspace with a recovery action", async () => {
    await failLoopClosureTerminally(
      "ws-1",
      "acme/repo",
      "lyrashield/fix-abc",
      42,
      "RETEST_NOT_ENTITLED"
    )
    expect(mockPrisma.loopClosure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "ws-1",
          repoFullName: "acme/repo",
          prNumber: 42,
          status: "pending",
        },
        data: { status: "failed", lastReason: "RETEST_NOT_ENTITLED" },
      })
    )
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        type: "loop_closure_failed",
        body: expect.stringContaining("Start the retest manually"),
      })
    )
  })
})

describe("claimDueLoopClosures", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reads due pending closures cross-workspace through the system client", async () => {
    mockPrisma.loopClosure.findMany.mockResolvedValue([
      {
        id: "closure-1",
        workspaceId: "ws-1",
        repoFullName: "acme/repo",
        branchName: "lyrashield/fix-abc",
        prNumber: 42,
        attempts: 2,
        lastReason: "SCAN_CONCURRENCY_LIMIT",
      },
    ])
    mockPrisma.loopClosure.updateMany.mockResolvedValue({ count: 1 })
    const due = await claimDueLoopClosures(new Date("2026-09-10T00:00:00Z"), 20)
    expect(due).toHaveLength(1)
    expect(due[0]?.attempts).toBe(3)
    expect(mockPrisma.loopClosure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "pending", nextRetryAt: { lte: new Date("2026-09-10T00:00:00Z") } },
        take: 20,
      })
    )
    expect(mockPrisma.loopClosure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "closure-1", attempts: 2 }),
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      })
    )
  })

  it("returns no row when another worker wins the claim", async () => {
    mockPrisma.loopClosure.findMany.mockResolvedValue([
      {
        id: "closure-1",
        workspaceId: "ws-1",
        repoFullName: "acme/repo",
        branchName: "lyrashield/fix-abc",
        prNumber: 42,
        attempts: 2,
        lastReason: "WORKER_UNAVAILABLE",
      },
    ])
    mockPrisma.loopClosure.updateMany.mockResolvedValue({ count: 0 })

    await expect(claimDueLoopClosures(new Date("2026-09-10T00:00:00Z"), 20)).resolves.toEqual([])
  })
})

describe("backoff schedule", () => {
  it("schedules bounded, increasing backoff and caps at the last step", () => {
    expect(LOOP_CLOSURE_BACKOFF_MINUTES[0]).toBe(1)
    const first = nextLoopClosureRetryAt(1, new Date(0))
    expect(first.getTime()).toBe(60_000)
    const capped = nextLoopClosureRetryAt(50, new Date(0))
    expect(capped.getTime()).toBe(
      LOOP_CLOSURE_BACKOFF_MINUTES[LOOP_CLOSURE_BACKOFF_MINUTES.length - 1] * 60_000
    )
    expect(LOOP_CLOSURE_MAX_ATTEMPTS).toBeGreaterThan(1)
  })
})

describe("completeLoopClosure", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.loopClosure.updateMany.mockResolvedValue({ count: 1 })
  })

  it("completes idempotently without reopening a terminal closure", async () => {
    await completeLoopClosure("ws-1", "acme/repo", 42)
    expect(mockPrisma.loopClosure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "pending" }),
        data: expect.objectContaining({ status: "completed" }),
      })
    )
  })
})
