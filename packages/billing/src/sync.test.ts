import { beforeEach, describe, expect, it, vi } from "vitest"

const grantMonthlyPoolMock = vi.hoisted(() => vi.fn())
const resetGraceMock = vi.hoisted(() => vi.fn())
const txBillingFindUnique = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const txBillingUpsert = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const auditCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const transactionMock = vi.hoisted(() =>
  vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      $executeRaw: vi.fn().mockResolvedValue(1),
      billingAccount: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: txBillingFindUnique,
        upsert: txBillingUpsert,
      },
      workspace: { update: vi.fn().mockResolvedValue({}) },
    })
  )
)

vi.mock("@lyrashield/db", () => ({
  prisma: {
    $transaction: transactionMock,
    auditLog: { create: auditCreateMock },
  },
  withWorkspaceRLS: (_workspaceId: string, callback: unknown) => transactionMock(callback),
  withAccountRLS: (_accountId: string, callback: unknown) => transactionMock(callback),
  getSystemPrisma: () => ({
    billingAccount: { findFirst: vi.fn().mockResolvedValue(null) },
  }),
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
  accountId: "acct_1",
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
  txBillingFindUnique.mockResolvedValue(null)
  txBillingUpsert.mockResolvedValue({})
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

describe("syncSubscription — out-of-order signed events (VERIFY-C-001)", () => {
  it("skips a delivery older than the last applied provider event", async () => {
    // Row already advanced to the September period at 2026-09-05.
    txBillingFindUnique.mockResolvedValue({
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      lastEventAt: new Date("2026-09-05T00:00:00.000Z"),
    })

    await syncSubscription({
      ...activeSubscription,
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      eventOccurredAt: new Date("2026-09-04T00:00:00.000Z"),
    })

    // Stale: the event predates the last applied provider event.
    expect(txBillingUpsert).not.toHaveBeenCalled()
    expect(grantMonthlyPoolMock).not.toHaveBeenCalled()
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "billing.subscription_stale_event" }),
      })
    )
  })

  it("skips a delivery that regresses currentPeriodStart even without an event clock", async () => {
    txBillingFindUnique.mockResolvedValue({
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      lastEventAt: null,
    })

    await syncSubscription({
      ...activeSubscription,
      // A replayed/redelivered event carrying the prior (August) period.
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    })

    expect(txBillingUpsert).not.toHaveBeenCalled()
    expect(grantMonthlyPoolMock).not.toHaveBeenCalled()
  })

  it("applies a same-period redelivery (equal clocks are not stale)", async () => {
    txBillingFindUnique.mockResolvedValue({
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      lastEventAt: new Date("2026-08-05T00:00:00.000Z"),
    })

    await syncSubscription({
      ...activeSubscription,
      eventOccurredAt: new Date("2026-08-05T00:00:00.000Z"),
    })

    expect(txBillingUpsert).toHaveBeenCalled()
    expect(grantMonthlyPoolMock).toHaveBeenCalled()
  })

  it("applies a newer event and advances the event clock", async () => {
    txBillingFindUnique.mockResolvedValue({
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      lastEventAt: new Date("2026-08-05T00:00:00.000Z"),
    })

    await syncSubscription({
      ...activeSubscription,
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      eventOccurredAt: new Date("2026-09-05T00:00:00.000Z"),
    })

    expect(txBillingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastEventAt: new Date("2026-09-05T00:00:00.000Z") }),
      })
    )
    expect(grantMonthlyPoolMock).toHaveBeenCalled()
  })
})
