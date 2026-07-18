import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  redis: { set: vi.fn() },
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
    mocks.redis.set.mockResolvedValue("OK")
    mocks.queue.getJob.mockResolvedValue(null)
    mocks.queue.getJobs.mockResolvedValue([])
    mocks.prisma.scan.findMany.mockResolvedValue([])
    mocks.updateScanStatus.mockResolvedValue({ id: "scan-1" })
  })

  it("fails stale queued scans without recreating jobs", async () => {
    mocks.prisma.scan.findMany.mockResolvedValueOnce([{ id: "scan-1" }]).mockResolvedValueOnce([])

    const result = await reconcileScanQueue(new Date("2026-07-18T12:00:00Z"))

    expect(result.failedOrphanedScans).toBe(1)
    expect(mocks.updateScanStatus).toHaveBeenCalledWith("scan-1", "FAILED", {
      errorCategory: "QUEUE",
      errorMessage: expect.stringContaining("QUEUE_ORPHANED"),
    })
    expect(mocks.redis.set).toHaveBeenCalledWith(
      "lyrashield:scan-queue:reconciliation",
      "leased",
      "PX",
      55_000,
      "NX"
    )
  })

  it("does nothing when another worker owns the reconciliation lease", async () => {
    mocks.redis.set.mockResolvedValue(null)

    await expect(reconcileScanQueue()).resolves.toEqual({
      failedOrphanedScans: 0,
      removedOrphanedJobs: 0,
    })

    expect(mocks.prisma.scan.findMany).not.toHaveBeenCalled()
    expect(mocks.queue.getJobs).not.toHaveBeenCalled()
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
})
