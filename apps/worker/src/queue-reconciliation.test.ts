import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  redis: { duplicate: vi.fn() },
  lockRedis: {
    owner: null as string | null,
    set: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
    watch: vi.fn(),
    get: vi.fn(),
    unwatch: vi.fn(),
    multi: vi.fn(),
    pexpire: vi.fn(),
    quit: vi.fn(),
  },
  queue: { getJob: vi.fn(), getJobs: vi.fn() },
  prisma: {
    scan: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  },
  updateScanStatus: vi.fn(),
}))

vi.mock("@lyrashield/integrations", () => ({ getRedis: () => mocks.redis }))
vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => mocks.prisma,
  prisma: mocks.prisma,
  TERMINAL_SCAN_STATUSES: new Set([
    "COMPLETED",
    "PARTIAL",
    "FAILED",
    "CANCELLED",
    "STOPPED_BUDGET",
    "TIMED_OUT",
  ]),
  updateScanStatus: mocks.updateScanStatus,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("./queue", () => ({ getScanQueue: () => mocks.queue }))

import {
  RECONCILIATION_IDLE_BACKSTOP_MS,
  reconcileFailedQueueJob,
  reconcileScanQueue,
  reconcileScanQueueIfNeeded,
} from "./queue-reconciliation"

describe("scan queue reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.lockRedis.owner = null
    mocks.redis.duplicate.mockReturnValue(mocks.lockRedis)
    mocks.lockRedis.on.mockReturnValue(mocks.lockRedis)
    mocks.lockRedis.set.mockImplementation(async (_key: string, token: string) => {
      mocks.lockRedis.owner = token
      return "OK"
    })
    mocks.lockRedis.watch.mockResolvedValue("OK")
    mocks.lockRedis.get.mockImplementation(async () => mocks.lockRedis.owner)
    mocks.lockRedis.unwatch.mockResolvedValue("OK")
    mocks.lockRedis.multi.mockImplementation(() => {
      let deletesLock = false
      const transaction = {
        pexpire: vi.fn((...args: unknown[]) => {
          mocks.lockRedis.pexpire(...args)
          return transaction
        }),
        del: vi.fn(() => {
          deletesLock = true
          return transaction
        }),
        exec: vi.fn(async () => {
          if (deletesLock) mocks.lockRedis.owner = null
          return [[null, 1]]
        }),
      }
      return transaction
    })
    mocks.lockRedis.quit.mockResolvedValue("OK")
    mocks.queue.getJob.mockResolvedValue(null)
    mocks.queue.getJobs.mockResolvedValue([])
    mocks.prisma.scan.count.mockResolvedValue(0)
    mocks.prisma.scan.findMany.mockResolvedValue([])
    mocks.updateScanStatus.mockResolvedValue({ id: "scan-1" })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reconciles every periodic tick while a nonterminal scan exists", async () => {
    mocks.prisma.scan.count.mockResolvedValue(1)
    const now = new Date("2026-07-18T12:00:00Z")

    await expect(reconcileScanQueueIfNeeded(now.getTime() - 300_000, now)).resolves.toMatchObject({
      leaseAcquired: true,
    })

    const preflight = mocks.prisma.scan.count.mock.calls[0]?.[0]
    expect(preflight).toEqual({
      where: {
        deletedAt: null,
        status: {
          notIn: ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"],
        },
      },
    })
    expect(preflight.where.status.notIn).not.toContain("REQUIRES_APPROVAL")
    expect(mocks.redis.duplicate).toHaveBeenCalledOnce()
  })

  it("skips Redis and BullMQ while idle before the hourly backstop", async () => {
    const now = new Date("2026-07-18T12:00:00Z")

    await expect(
      reconcileScanQueueIfNeeded(now.getTime() - RECONCILIATION_IDLE_BACKSTOP_MS + 1, now)
    ).resolves.toBeNull()

    expect(mocks.redis.duplicate).not.toHaveBeenCalled()
    expect(mocks.queue.getJobs).not.toHaveBeenCalled()
  })

  it("reconciles idle queues at the exact hourly backstop", async () => {
    const now = new Date("2026-07-18T12:00:00Z")

    await expect(
      reconcileScanQueueIfNeeded(now.getTime() - RECONCILIATION_IDLE_BACKSTOP_MS, now)
    ).resolves.toMatchObject({ leaseAcquired: true })

    expect(mocks.redis.duplicate).toHaveBeenCalledOnce()
  })

  it("reconciles fail-safe when the database preflight errors", async () => {
    mocks.prisma.scan.count.mockRejectedValue(new Error("database unavailable"))

    await expect(reconcileScanQueueIfNeeded(Date.now())).resolves.toMatchObject({
      leaseAcquired: true,
    })

    expect(mocks.redis.duplicate).toHaveBeenCalledOnce()
  })

  it("keeps direct startup reconciliation unconditional", async () => {
    mocks.prisma.scan.count.mockRejectedValue(new Error("preflight must not run"))

    await expect(reconcileScanQueue()).resolves.toMatchObject({ leaseAcquired: true })

    expect(mocks.prisma.scan.count).not.toHaveBeenCalled()
    expect(mocks.redis.duplicate).toHaveBeenCalledOnce()
  })

  it("fails stale queued scans without recreating jobs", async () => {
    mocks.prisma.scan.findMany
      .mockResolvedValueOnce([{ id: "scan-1", workspaceId: "ws-1" }])
      .mockResolvedValueOnce([])

    const result = await reconcileScanQueue(new Date("2026-07-18T12:00:00Z"))

    expect(result.failedOrphanedScans).toBe(1)
    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      {
        errorCategory: "QUEUE",
        errorMessage: expect.stringContaining("QUEUE_ORPHANED"),
      },
      "ws-1"
    )
    expect(mocks.lockRedis.set).toHaveBeenCalledWith(
      "lyrashield:scan-queue:reconciliation",
      expect.any(String),
      "PX",
      55_000,
      "NX"
    )
  })

  it("does nothing when another worker owns the reconciliation lease", async () => {
    mocks.lockRedis.set.mockResolvedValue(null)

    await expect(reconcileScanQueue()).resolves.toEqual({
      leaseAcquired: false,
      failedOrphanedScans: 0,
      removedOrphanedJobs: 0,
      queueDepth: 0,
      oldestWaitingJobAgeMs: 0,
    })

    expect(mocks.prisma.scan.findMany).not.toHaveBeenCalled()
    expect(mocks.queue.getJobs).not.toHaveBeenCalled()
  })

  it("renews the token-owned lease during a slow reconciliation", async () => {
    vi.useFakeTimers()
    let resolveScans: ((value: Array<{ id: string }>) => void) | undefined
    mocks.prisma.scan.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScans = resolve
        })
    )

    const reconciliation = reconcileScanQueue()
    await vi.advanceTimersByTimeAsync(50_000)

    expect(mocks.lockRedis.pexpire).toHaveBeenCalledWith(
      "lyrashield:scan-queue:reconciliation",
      55_000
    )

    resolveScans?.([])
    await reconciliation
  })

  it("removes waiting jobs whose database scan is absent or terminal", async () => {
    const timestamp = new Date("2026-07-18T11:57:00Z").getTime()
    const missing = { id: "missing", timestamp, remove: vi.fn().mockResolvedValue(undefined) }
    const terminal = { id: "terminal", timestamp, remove: vi.fn().mockResolvedValue(undefined) }
    const active = { id: "active", timestamp, remove: vi.fn().mockResolvedValue(undefined) }
    mocks.queue.getJobs.mockResolvedValue([missing, terminal, active])
    mocks.prisma.scan.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "terminal", status: "COMPLETED" },
      { id: "active", status: "QUEUED" },
    ])

    const result = await reconcileScanQueue(new Date("2026-07-18T12:00:00Z"))

    expect(result.removedOrphanedJobs).toBe(2)
    expect(result.queueDepth).toBe(1)
    expect(result.oldestWaitingJobAgeMs).toBe(180_000)
    expect(missing.remove).toHaveBeenCalled()
    expect(terminal.remove).toHaveBeenCalled()
    expect(active.remove).not.toHaveBeenCalled()
  })

  it("marks an active scan failed when BullMQ reports final failure", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue({ status: "RUNNING", workspaceId: "ws-1" })

    await reconcileFailedQueueJob("scan-1", "worker crashed", 3, 3)

    expect(mocks.updateScanStatus).toHaveBeenCalledWith(
      "scan-1",
      "FAILED",
      {
        errorCategory: "QUEUE",
        errorMessage: "Queue job failed: worker crashed",
      },
      "ws-1"
    )
  })

  it("keeps an active scan retryable while BullMQ has attempts remaining", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue({ status: "QUEUED", workspaceId: "ws-1" })

    await reconcileFailedQueueJob("scan-1", "temporary failure", 1, 3)

    expect(mocks.prisma.scan.findUnique).not.toHaveBeenCalled()
    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })

  it("contains database failures from the queue failure callback", async () => {
    mocks.prisma.scan.findUnique.mockRejectedValue(new Error("database unavailable"))

    await expect(reconcileFailedQueueJob("scan-1", "worker crashed", 3, 3)).resolves.toBeUndefined()

    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })
})
