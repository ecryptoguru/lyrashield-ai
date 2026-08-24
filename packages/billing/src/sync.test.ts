import { beforeEach, describe, expect, it, vi } from "vitest"

const grantMonthlyPoolMock = vi.hoisted(() => vi.fn())
const resetGraceMock = vi.hoisted(() => vi.fn())
const transactionMock = vi.hoisted(() =>
  vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      billingAccount: { upsert: vi.fn().mockResolvedValue({}) },
      workspace: { update: vi.fn().mockResolvedValue({}) },
    })
  )
)

vi.mock("@lyrashield/db", () => ({
  prisma: {
    $transaction: transactionMock,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({
  CLOUD_PLAN_MAP: { PRO: { agentMinutes: 1_000, deepAllowed: true } },
}))
vi.mock("./usage/grants", () => ({
  grantMonthlyPool: (...args: unknown[]) => grantMonthlyPoolMock(...args),
}))
vi.mock("./grace", () => ({ resetGrace: (...args: unknown[]) => resetGraceMock(...args) }))

import { syncSubscription } from "./sync"

const activeSubscription = {
  workspaceId: "ws_1",
  provider: "razorpay" as const,
  externalId: "sub_1",
  plan: "PRO" as const,
  status: "active" as const,
  interval: "monthly" as const,
  currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  grantMonthlyPoolMock.mockResolvedValue({ created: true })
  resetGraceMock.mockResolvedValue(undefined)
})

describe("syncSubscription paid-event durability", () => {
  it.each([
    ["minute grant", grantMonthlyPoolMock],
    ["grace reset", resetGraceMock],
  ])("rejects when %s fails so the webhook track retries", async (_label, failingStep) => {
    failingStep.mockRejectedValueOnce(new Error("durable side effect failed"))

    await expect(syncSubscription(activeSubscription)).rejects.toThrow("durable side effect failed")
  })

  it("rejects an active paid event without period-start evidence", async () => {
    await expect(
      syncSubscription({ ...activeSubscription, currentPeriodStart: undefined })
    ).rejects.toThrow("active_subscription_missing_period_start")

    expect(transactionMock).not.toHaveBeenCalled()
  })
})
