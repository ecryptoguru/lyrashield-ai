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
  $queryRaw: vi.fn(),
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
    systemPrisma.$queryRaw.mockResolvedValue([
      {
        accountsCreated: 40n,
        setupStarted: 30n,
        validAssessments: 24n,
        ttfvMedianMinutes: 12.5,
        ttfvP90Minutes: 45,
        githubConnectStarted: 25n,
        githubConnected: 20n,
        targetsZero: 10n,
        targetsOne: 20n,
        targetsTwo: 7n,
        targetsThreePlus: 3n,
        recoveryFailures: 20n,
        recoverySuccesses: 12n,
        completedAccounts: 20n,
        repeatSevenDays: 8n,
        repeatTwentyEightDays: 14n,
      },
    ])
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
      activation: {
        minimumSample: 20,
        activation: { numerator: 24, denominator: 40, percent: 60 },
        setupAbandonment: { numerator: 10, denominator: 40, percent: 25 },
        timeToFirstValidAssessment: {
          denominator: 24,
          medianMinutes: 12.5,
          p90Minutes: 45,
        },
        connectionSuccess: { numerator: 20, denominator: 25, percent: 80 },
        repeatedInput: {
          denominator: 40,
          zero: 10,
          one: 20,
          two: 7,
          threePlus: 3,
          sufficient: true,
        },
        recoverySuccess: { numerator: 12, denominator: 20, percent: 60 },
        repeatAssessment: {
          sevenDays: { numerator: 8, denominator: 20, percent: 40 },
          twentyEightDays: { numerator: 14, denominator: 20, percent: 70 },
        },
      },
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

  it("renders percentages only after the defined minimum sample", async () => {
    systemPrisma.$queryRaw.mockResolvedValue([
      {
        accountsCreated: 3n,
        setupStarted: 1n,
        validAssessments: 1n,
        ttfvMedianMinutes: 4,
        ttfvP90Minutes: 4,
        githubConnectStarted: 2n,
        githubConnected: 1n,
        targetsZero: 2n,
        targetsOne: 1n,
        targetsTwo: 0n,
        targetsThreePlus: 0n,
        recoveryFailures: 1n,
        recoverySuccesses: 1n,
        completedAccounts: 1n,
        repeatSevenDays: 1n,
        repeatTwentyEightDays: 1n,
      },
    ])

    const { activation } = await getPlatformAdminOverview()

    expect(activation?.activation.percent).toBeNull()
    expect(activation?.timeToFirstValidAssessment.medianMinutes).toBeNull()
    expect(activation?.connectionSuccess.percent).toBeNull()
    expect(activation?.repeatedInput.sufficient).toBe(false)
    expect(activation?.recoverySuccess.percent).toBeNull()
    expect(activation?.repeatAssessment.sevenDays.percent).toBeNull()
  })
})
