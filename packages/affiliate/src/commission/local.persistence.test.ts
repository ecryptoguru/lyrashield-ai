import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  conversions: [] as Array<Record<string, unknown>>,
  commissions: [] as Array<Record<string, unknown>>,
}))

vi.mock("@lyrashield/db", async () => {
  const { Decimal } = await import("@prisma/client-runtime-utils")
  return {
    Prisma: { Decimal },
    prisma: {
      conversion: {
        findFirst: vi.fn(({ where: { idempotencyKey } }) => {
          const conversion = state.conversions.find((row) => row.idempotencyKey === idempotencyKey)
          if (!conversion) return null
          return {
            ...conversion,
            commissions: state.commissions.filter(
              (commission) => commission.conversionId === conversion.id
            ),
          }
        }),
        create: vi.fn(({ data }) => {
          const conversion = { id: `conv_${state.conversions.length + 1}`, ...data }
          state.conversions.push(conversion)
          return conversion
        }),
      },
      commission: {
        create: vi.fn(({ data }) => {
          const commission = { id: `comm_${state.commissions.length + 1}`, ...data }
          state.commissions.push(commission)
          return commission
        }),
      },
      affiliate: {
        findUnique: vi.fn(({ select }) =>
          select.status
            ? { id: "aff_1", status: "APPROVED" }
            : { user: { email: "owner@example.com" } }
        ),
      },
    },
  }
})
vi.mock("@lyrashield/config", () => ({
  env: { NODE_ENV: "test", AFFILIATE_DEFAULT_PROGRAM_SLUG: "default" },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock("../program", () => ({
  loadActiveProgram: vi.fn().mockResolvedValue({ holdDays: 30 }),
}))

import { onLocalOrderPaid } from "./local"

beforeEach(() => {
  state.conversions.length = 0
  state.commissions.length = 0
})

describe("Local commission money durability", () => {
  it("persists GST and creates one commission across 100 replays", async () => {
    const payment = {
      provider: "razorpay",
      externalId: "pay_local_1",
      customerId: "customer_1",
      customerEmail: "buyer@example.com",
      grossAmount: "19900.0000",
      discountAmount: "0.0000",
      taxAmount: "3035.5932",
      commissionableAmount: "16864.4068",
      currency: "INR",
      skuId: "individual_regular",
      affiliateId: "aff_1",
    }

    await onLocalOrderPaid(payment)
    for (let replay = 0; replay < 100; replay += 1) await onLocalOrderPaid(payment)

    expect(state.conversions).toHaveLength(1)
    expect(state.commissions).toHaveLength(1)
    expect(String(state.conversions[0].taxAmount)).toBe("3035.5932")
    expect(String(state.commissions[0].amount)).toBe("3372.8814")
  })
})
