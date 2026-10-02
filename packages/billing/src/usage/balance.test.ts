import { afterEach, beforeEach, expect, it, vi } from "vitest"

const withAccountRLSMock = vi.hoisted(() => vi.fn())
const db = vi.hoisted(() => ({
  billingAccount: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  minutePack: { findMany: vi.fn() },
  usageRecord: { aggregate: vi.fn(), groupBy: vi.fn() },
}))

vi.mock("@lyrashield/db", () => ({
  withAccountRLS: withAccountRLSMock,
  prisma: db,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { getUsageBalance, resolveBalanceCycleStart } from "./balance"

function billingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ba_1",
    accountId: "acct_1",
    workspaceId: "ws_1",
    purchaseWorkspaceId: "ws_1",
    provider: "polar",
    externalId: "sub_1",
    status: "active",
    currentPlan: "PRO",
    interval: "monthly",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    canceledAt: null,
    trialEndsAt: null,
    spendLimitCents: null,
    graceUsedMs: 0,
    graceCycleStart: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  withAccountRLSMock.mockImplementation((accountId, callback) => {
    expect(accountId).toBe("acct_1")
    return callback(db)
  })
  db.billingAccount.findMany.mockResolvedValue([])
  db.user.findUnique.mockResolvedValue({ trialStartedAt: new Date("2026-09-01") })
  db.minutePack.findMany.mockResolvedValue([])
  db.usageRecord.aggregate.mockResolvedValue({ _sum: { quantity: 100 } })
  db.usageRecord.groupBy.mockResolvedValue([
    { kind: "agent_minutes", _sum: { quantity: 12 } },
    { kind: "overage_minutes", _sum: { quantity: 3 } },
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

it("uses aggregated quantities and the trial boundary when the billing period is absent", async () => {
  expect(await getUsageBalance("acct_1")).toMatchObject({
    poolMinutes: 100,
    poolConsumed: 12,
    overageConsumed: 3,
    totalRemaining: 88,
    cycleStart: new Date("2026-09-01"),
  })
  expect(db.usageRecord.groupBy).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        accountId: "acct_1",
        cycleStart: { gte: new Date("2026-09-01") },
      }),
    })
  )
})

it("preserves a billing cycle and treats empty sums as zero", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"))
  db.billingAccount.findMany.mockResolvedValue([
    billingRow({ currentPeriodStart: new Date("2026-09-02") }),
  ])
  db.usageRecord.aggregate.mockResolvedValue({ _sum: { quantity: null } })
  db.usageRecord.groupBy.mockResolvedValue([])
  expect(await getUsageBalance("acct_1")).toMatchObject({
    totalRemaining: 0,
    cycleStart: new Date("2026-09-02"),
  })
  expect(db.usageRecord.aggregate).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ accountId: "acct_1" }),
    })
  )
})

it.each([
  ["before the period starts", "2026-09-01", "2026-09-02"],
  ["at the period start", "2026-09-02", "2026-09-02"],
  ["before the next monthly anniversary", "2026-10-01", "2026-09-02"],
  ["at the next monthly anniversary", "2026-10-02", "2026-10-02"],
  ["after the next monthly anniversary", "2026-10-03", "2026-10-02"],
])("resolves the cycle correctly %s", (_label, at, expectedCycleStart) => {
  expect(
    resolveBalanceCycleStart({
      billing: {
        interval: "monthly",
        currentPeriodStart: new Date("2026-09-02"),
        currentPeriodEnd: null,
      },
      trialStartedAt: null,
      at: new Date(`${at}T00:00:00.000Z`),
    })
  ).toEqual(new Date(`${expectedCycleStart}T00:00:00.000Z`))
})
