import { beforeEach, expect, it, vi } from "vitest"
const db = vi.hoisted(() => ({
  billingAccount: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
  minutePack: { findMany: vi.fn() },
  usageRecord: { aggregate: vi.fn(), groupBy: vi.fn() },
}))
vi.mock("@lyrashield/db", () => ({ prisma: db }))
import { getUsageBalance } from "./balance"
beforeEach(() => {
  vi.clearAllMocks()
  db.billingAccount.findUnique.mockResolvedValue({ currentPeriodStart: null })
  db.workspace.findUnique.mockResolvedValue({ trialStartedAt: new Date("2026-09-01") })
  db.minutePack.findMany.mockResolvedValue([])
  db.usageRecord.aggregate.mockResolvedValue({ _sum: { quantity: 100 } })
  db.usageRecord.groupBy.mockResolvedValue([
    { kind: "agent_minutes", _sum: { quantity: 12 } },
    { kind: "overage_minutes", _sum: { quantity: 3 } },
  ])
})
it("uses aggregated quantities and the trial boundary when the billing period is absent", async () => {
  expect(await getUsageBalance("workspace-1")).toMatchObject({
    poolMinutes: 100,
    poolConsumed: 12,
    overageConsumed: 3,
    totalRemaining: 88,
    cycleStart: new Date("2026-09-01"),
  })
  expect(db.usageRecord.groupBy).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "workspace-1",
        cycleStart: { gte: new Date("2026-09-01") },
      }),
    })
  )
})
it("preserves a billing cycle and treats empty sums as zero", async () => {
  db.billingAccount.findUnique.mockResolvedValue({ currentPeriodStart: new Date("2026-09-02") })
  db.usageRecord.aggregate.mockResolvedValue({ _sum: { quantity: null } })
  db.usageRecord.groupBy.mockResolvedValue([])
  expect(await getUsageBalance("workspace-1")).toMatchObject({
    totalRemaining: 0,
    cycleStart: new Date("2026-09-02"),
  })
  expect(db.workspace.findUnique).not.toHaveBeenCalled()
})
