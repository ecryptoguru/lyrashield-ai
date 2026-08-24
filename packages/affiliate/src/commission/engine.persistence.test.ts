import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  conversions: [] as Array<Record<string, unknown>>,
  commissions: [] as Array<Record<string, unknown>>,
}))

vi.mock("@lyrashield/db", async () => {
  const { Decimal } = await import("@prisma/client-runtime-utils")
  return {
    Prisma: { Decimal },
    getSystemPrisma: vi.fn(() => ({})),
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
        findUnique: vi.fn(({ select }) => {
          if (select.status) return { id: "aff_1", status: "APPROVED" }
          if (select.user) return { userId: "user_1", user: { email: "owner@example.com" } }
          return {
            activeReferrals: 0,
            baseRateBps: 2500,
            tierRateBps: 3000,
            tierThreshold: 10,
          }
        }),
        update: vi.fn(),
      },
      affiliateSubscription: { findUnique: vi.fn(), create: vi.fn() },
      click: { count: vi.fn().mockResolvedValue(0) },
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
  loadActiveProgram: vi.fn().mockResolvedValue({ holdDays: 30, capMonths: 12 }),
}))

import { normalizeProviderEvent } from "../../../billing/src/domain-events"
import { onOrderPaid } from "./engine"

beforeEach(() => {
  state.conversions.length = 0
  state.commissions.length = 0
})

describe("Cloud commission money durability", () => {
  it("persists Razorpay INR GST and creates one commission across 100 replays", async () => {
    const event = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "subscription.charged",
      deliveryId: "evt_inr_1",
      payload: {
        event: "subscription.charged",
        created_at: 1_755_000_000,
        payload: {
          subscription: { entity: { id: "sub_1", status: "active" } },
          payment: {
            entity: {
              id: "pay_1",
              amount: 290_000,
              currency: "INR",
              customer_email: "buyer@example.com",
            },
          },
        },
      },
    })

    expect(event.money).toEqual({
      currency: "INR",
      grossAmount: "2900.0000",
      discountAmount: "0.0000",
      taxAmount: "442.3729",
      commissionableAmount: "2457.6271",
    })

    const payment = {
      provider: "razorpay",
      externalId: "pay_1",
      customerId: "customer_1",
      customerEmail: "buyer@example.com",
      ...event.money!,
      affiliateId: "aff_1",
    }
    await onOrderPaid(payment)
    for (let replay = 0; replay < 100; replay += 1) await onOrderPaid(payment)

    expect(state.conversions).toHaveLength(1)
    expect(state.commissions).toHaveLength(1)
    expect(String(state.conversions[0].taxAmount)).toBe("442.3729")
    expect(String(state.commissions[0].amount)).toBe("614.4068")
  })
})
