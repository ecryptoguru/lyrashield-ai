import { beforeEach, describe, expect, it, vi } from "vitest"

const transactionMock = vi.hoisted(() => vi.fn())
const executeRawMock = vi.hoisted(() => vi.fn().mockResolvedValue(1))
const usageCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "usage_1" }))
const usageFindUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))

vi.mock("@lyrashield/db", () => ({
  prisma: { $transaction: transactionMock },
  withWorkspaceRLS: (_workspaceId: string, callback: unknown, options: unknown) =>
    transactionMock(callback, options),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/pricing", () => ({ STANDARD_OVERAGE_PER_MINUTE_USD: 0.15 }))

import { debitOverage } from "./overage"

beforeEach(() => {
  vi.clearAllMocks()
  const tx = {
    $executeRaw: executeRawMock,
    billingAccount: {
      findUnique: vi.fn().mockResolvedValue({
        currentPlan: "TEAM",
        spendLimitCents: 100,
        currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      }),
    },
    usageRecord: {
      findUnique: usageFindUniqueMock,
      findMany: vi.fn().mockResolvedValue([{ quantity: 5 }]),
      create: usageCreateMock,
    },
  }
  transactionMock.mockImplementation((callback, options) => {
    expect(options).toEqual({ isolationLevel: "Serializable" })
    return callback(tx)
  })
})

describe("debitOverage", () => {
  it("serializes the debit and returns a partial debit at the spend limit", async () => {
    const result = await debitOverage("ws_1", 3, "scan_1", "engine_overage")

    expect(executeRawMock).toHaveBeenCalledOnce()
    expect(usageCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        quantity: 1,
        idempotencyKey: "ws_1:scan_1:engine_overage:overage",
      }),
    })
    expect(result).toEqual({ debited: true, minutes: 1, estimatedCostCents: 15 })
  })

  it("retries a serialization conflict", async () => {
    transactionMock.mockRejectedValueOnce({ code: "P2034" })

    await expect(debitOverage("ws_1", 1, "scan_1", "engine_overage")).resolves.toMatchObject({
      debited: true,
      minutes: 1,
    })
    expect(transactionMock).toHaveBeenCalledTimes(2)
  })

  it("restores a completed debit on an idempotent replay", async () => {
    usageFindUniqueMock.mockResolvedValueOnce({ id: "usage_1", quantity: 3 })

    await expect(debitOverage("ws_1", 3, "scan_1", "engine_overage")).resolves.toEqual({
      debited: true,
      minutes: 3,
      estimatedCostCents: 45,
      reason: "idempotent_replay",
    })
    expect(usageCreateMock).not.toHaveBeenCalled()
  })
})
