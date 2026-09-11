import { beforeEach, describe, expect, it, vi } from "vitest"

const withAccountRLSMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const usageCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "usage_1" }))
const usageFindUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))

vi.mock("@lyrashield/db", () => ({
  withAccountRLS: withAccountRLSMock,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({ STANDARD_OVERAGE_PER_MINUTE_USD: 0.15 }))

import { debitOverage } from "./overage"

const input = {
  accountId: "acct_1",
  workspaceId: "ws_1",
  scanId: "scan_1",
  phase: "engine_overage",
}

beforeEach(() => {
  vi.clearAllMocks()
  const tx = {
    $executeRaw: executeRawMock,
    billingAccount: {
      // resolveAccountBilling: account-owned governing-row lookup.
      findMany: vi.fn().mockResolvedValue([
        {
          id: "ba_1",
          accountId: "acct_1",
          workspaceId: "ws_1",
          purchaseWorkspaceId: "ws_1",
          provider: "polar",
          externalId: "sub_1",
          status: "active",
          currentPlan: "LAUNCH_ASSURANCE",
          interval: "monthly",
          spendLimitCents: 100,
          currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
          currentPeriodEnd: null,
          canceledAt: null,
          trialEndsAt: null,
          graceUsedMs: 0,
          graceCycleStart: null,
          deletedAt: null,
          updatedAt: new Date(),
        },
      ]),
    },
    usageRecord: {
      findUnique: usageFindUniqueMock,
      findMany: vi.fn().mockResolvedValue([{ quantity: 5 }]),
      create: usageCreateMock,
    },
  }
  withAccountRLSMock.mockImplementation((accountId, callback, options) => {
    expect(accountId).toBe("acct_1")
    expect(options).toEqual({ isolationLevel: "Serializable" })
    return callback(tx)
  })
})

describe("debitOverage", () => {
  it("serializes the debit and returns a partial debit at the spend limit", async () => {
    const result = await debitOverage({ ...input, minutes: 3 })

    expect(executeRawMock).toHaveBeenCalledOnce()
    expect(usageCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: "acct_1",
        quantity: 1,
        idempotencyKey: "ws_1:scan_1:engine_overage:overage",
      }),
    })
    expect(result).toEqual({ debited: true, minutes: 1, estimatedCostCents: 15 })
  })

  it("retries a serialization conflict", async () => {
    withAccountRLSMock.mockRejectedValueOnce({ code: "P2034" })

    await expect(debitOverage({ ...input, minutes: 1 })).resolves.toMatchObject({
      debited: true,
      minutes: 1,
    })
    expect(withAccountRLSMock).toHaveBeenCalledTimes(2)
  })

  it("restores a completed debit on an idempotent replay", async () => {
    usageFindUniqueMock.mockResolvedValueOnce({ id: "usage_1", quantity: 3 })

    await expect(debitOverage({ ...input, minutes: 3 })).resolves.toEqual({
      debited: true,
      minutes: 3,
      estimatedCostCents: 45,
      reason: "idempotent_replay",
    })
    expect(usageCreateMock).not.toHaveBeenCalled()
  })
})
