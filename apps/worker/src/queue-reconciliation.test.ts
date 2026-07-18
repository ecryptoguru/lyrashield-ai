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
    scan: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  updateScanStatus: vi.fn(),
}))

vi.mock("@lyrashield/integrations", () => ({ getRedis: () => mocks.redis }))
vi.mock("@lyrashield/db", () => ({
  prisma: mocks.prisma,
  updateScanStatus: mocks.updateScanStatus,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("./queue", () => ({ getScanQueue: () => mocks.queue }))

import { reconcileFailedQueueJob, reconcileScanQueue } from "./queue-reconciliation"

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
    mocks.prisma.scan.findMany.mockResolvedValue([])
    mocks.updateScanStatus.mockResolvedValue({ id: "scan-1" })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fails stale queued scans without recreating jobs", async () => {
    mocks.prisma.scan.findMany.mockResolvedValueOnce([{ id: "scan-1" }]).mockResolvedValueOnce([])

    const result = await reconcileScanQueue(new Date("2026-07-18T12:00:00Z"))

    expect(result.failedOrphanedScans).toBe(1)
    expect(mocks.updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "QUEUE",
      errorMessage: expect.stringContaining("QUEUE_ORPHANED"),
    })
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
      failedOrphanedScans: 0,
      removedOrphanedJobs: 0,
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
    await vi.advanceTimersByTimeAsync(20_000)

    expect(mocks.lockRedis.pexpire).toHaveBeenCalledWith(
      "lyrashield:scan-queue:reconciliation",
      55_000
    )

    resolveScans?.([])
    await reconciliation
  })

  it("removes waiting jobs whose database scan is absent or terminal", async () => {
    const missing = { id: "missing", remove: vi.fn().mockResolvedValue(undefined) }
    const terminal = { id: "terminal", remove: vi.fn().mockResolvedValue(undefined) }
    const active = { id: "active", remove: vi.fn().mockResolvedValue(undefined) }
    mocks.queue.getJobs.mockResolvedValue([missing, terminal, active])
    mocks.prisma.scan.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "terminal", status: "COMPLETED" },
      { id: "active", status: "QUEUED" },
    ])

    const result = await reconcileScanQueue()

    expect(result.removedOrphanedJobs).toBe(2)
    expect(missing.remove).toHaveBeenCalled()
    expect(terminal.remove).toHaveBeenCalled()
    expect(active.remove).not.toHaveBeenCalled()
  })

  it("marks an active scan failed when BullMQ reports final failure", async () => {
    mocks.prisma.scan.findUnique.mockResolvedValue({ status: "RUNNING" })

    await reconcileFailedQueueJob("scan-1", "worker crashed")

    expect(mocks.updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "QUEUE",
      errorMessage: "Queue job failed: worker crashed",
    })
  })

  it("contains database failures from the queue failure callback", async () => {
    mocks.prisma.scan.findUnique.mockRejectedValue(new Error("database unavailable"))

    await expect(reconcileFailedQueueJob("scan-1", "worker crashed")).resolves.toBeUndefined()

    expect(mocks.updateScanStatus).not.toHaveBeenCalled()
  })
})
