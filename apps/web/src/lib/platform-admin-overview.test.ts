import { beforeEach, describe, expect, it, vi } from "vitest"

const systemPrisma = {
  user: { count: vi.fn() },
  workspace: { count: vi.fn() },
  target: { count: vi.fn() },
  scan: { groupBy: vi.fn() },
  billingAccount: { groupBy: vi.fn() },
  webhookEventTrack: { count: vi.fn() },
  affiliate: { count: vi.fn() },
  payout: { count: vi.fn() },
}

const getJobCounts = vi.fn()
const isScanWorkerAvailable = vi.fn()

vi.mock("@lyrashield/db", () => ({ getSystemPrisma: () => systemPrisma }))
vi.mock("@lyrashield/integrations", () => ({
  getScanQueue: () => ({ getJobCounts }),
  isScanWorkerAvailable: (...args: unknown[]) => isScanWorkerAvailable(...args),
}))

import { getPlatformAdminOverview } from "./platform-admin-overview"

describe("getPlatformAdminOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    systemPrisma.user.count.mockResolvedValue(12)
    systemPrisma.workspace.count.mockResolvedValue(5)
    systemPrisma.target.count.mockResolvedValue(9)
    systemPrisma.scan.groupBy.mockResolvedValue([
      { status: "QUEUED", _count: { _all: 2 } },
      { status: "RUNNING", _count: { _all: 1 } },
      { status: "COMPLETED", _count: { _all: 20 } },
      { status: "FAILED", _count: { _all: 1 } },
    ])
    systemPrisma.billingAccount.groupBy.mockResolvedValue([
      { status: "active", _count: { _all: 3 } },
      { status: "free", _count: { _all: 2 } },
    ])
    systemPrisma.webhookEventTrack.count.mockResolvedValue(1)
    systemPrisma.affiliate.count.mockResolvedValue(2)
    systemPrisma.payout.count.mockResolvedValue(1)
    getJobCounts.mockResolvedValue({ wait: 2, active: 1, delayed: 0, failed: 1 })
    isScanWorkerAvailable.mockResolvedValue(true)
  })

  it("returns bounded platform aggregates without customer payloads", async () => {
    await expect(getPlatformAdminOverview()).resolves.toEqual({
      database: { status: "healthy", users: 12, workspaces: 5, targets: 9 },
      scans: { status: "healthy", queued: 2, active: 1, completed: 20, failed: 1 },
      billing: { status: "degraded", active: 3, free: 2, deadLetters: 1 },
      affiliates: { status: "degraded", pendingApplications: 2, pendingPayouts: 1 },
      worker: { status: "healthy", available: true },
      queue: { status: "degraded", waiting: 2, active: 1, delayed: 0, failed: 1 },
      generatedAt: expect.any(String),
    })
    expect(systemPrisma.webhookEventTrack.count).toHaveBeenCalledWith({
      where: { status: "dead_letter" },
    })
  })

  it("keeps other cards available when one dependency fails", async () => {
    systemPrisma.user.count.mockRejectedValue(new Error("database unavailable"))
    getJobCounts.mockRejectedValue(new Error("redis unavailable"))
    isScanWorkerAvailable.mockResolvedValue(false)

    const overview = await getPlatformAdminOverview()

    expect(overview.database).toEqual({
      status: "unknown",
      users: null,
      workspaces: null,
      targets: null,
    })
    expect(overview.queue).toEqual({
      status: "unknown",
      waiting: null,
      active: null,
      delayed: null,
      failed: null,
    })
    expect(overview.worker).toEqual({ status: "degraded", available: false })
    expect(overview.billing.status).toBe("degraded")
  })
})
