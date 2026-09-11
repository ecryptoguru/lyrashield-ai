import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  conversions: [] as Array<Record<string, unknown>>,
  commissions: [] as Array<Record<string, unknown>>,
  affiliateSubscriptions: [] as Array<Record<string, unknown>>,
  referralIncrements: 0,
}))

vi.mock("@lyrashield/db", async () => {
  const { Decimal } = await import("@prisma/client-runtime-utils")
  return {
    Prisma: { Decimal },
    getSystemPrisma: vi.fn(() => ({})),
    prisma: {
      $transaction: vi.fn((callback) =>
        callback({
          conversion: {
            create: ({ data }: { data: Record<string, unknown> }) => {
              const conversion = { id: `conv_${state.conversions.length + 1}`, ...data }
              state.conversions.push(conversion)
              return conversion
            },
          },
          commission: {
            create: ({ data }: { data: Record<string, unknown> }) => {
              const commission = { id: `comm_${state.commissions.length + 1}`, ...data }
              state.commissions.push(commission)
              return commission
            },
          },
        })
      ),
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
        update: vi.fn(({ data }) => {
          if (data?.activeReferrals?.increment) state.referralIncrements += 1
        }),
      },
      affiliateSubscription: {
        findUnique: vi.fn(({ where: { providerSubscriptionId } }) => {
          return (
            state.affiliateSubscriptions.find(
              (row) => row.providerSubscriptionId === providerSubscriptionId
            ) ?? null
          )
        }),
        create: vi.fn(({ data }) => {
          if (
            state.affiliateSubscriptions.some(
              (row) => row.providerSubscriptionId === data.providerSubscriptionId
            )
          ) {
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
          }
          const row = { id: `asub_${state.affiliateSubscriptions.length + 1}`, ...data }
          state.affiliateSubscriptions.push(row)
          return row
        }),
      },
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
  state.affiliateSubscriptions.length = 0
  state.referralIncrements = 0
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

describe("Cloud commission — 12-month cap (VULN-C-001)", () => {
  const renewal = {
    provider: "razorpay",
    externalId: "pay_renewal_1",
    providerSubscriptionId: "sub_cap_1",
    customerId: "customer_1",
    customerEmail: "buyer@example.com",
    grossAmount: "2900.0000",
    discountAmount: "0.0000",
    taxAmount: "442.3729",
    commissionableAmount: "2457.6271",
    currency: "INR",
    affiliateId: "aff_1",
    // Deliberately no isFirstPayment — no producer stamps it.
  }

  it("creates the cap window from the first observed paid event, even a renewal", async () => {
    const result = await onOrderPaid(renewal)

    expect(state.affiliateSubscriptions).toHaveLength(1)
    const sub = state.affiliateSubscriptions[0]
    expect(sub.providerSubscriptionId).toBe("sub_cap_1")
    expect(sub.firstPaidAt).toBeInstanceOf(Date)
    expect((sub.capEndsAt as Date).getTime()).toBeGreaterThan(Date.now())
    expect(result.status).toBe("PENDING")
    expect(state.referralIncrements).toBe(1)
  })

  it("creates the subscription row once across repeated renewals", async () => {
    await onOrderPaid(renewal)
    await onOrderPaid({ ...renewal, externalId: "pay_renewal_2" })

    expect(state.affiliateSubscriptions).toHaveLength(1)
    expect(state.referralIncrements).toBe(1)
  })

  it("mints EXPIRED amount=0 once the cap window has passed", async () => {
    // Seed the subscription 13 months in — past the 12-month cap.
    const now = new Date()
    state.affiliateSubscriptions.push({
      id: "asub_old",
      providerSubscriptionId: "sub_cap_1",
      provider: "razorpay",
      customerId: "customer_1",
      affiliateId: "aff_1",
      firstPaidAt: new Date(now.getFullYear(), now.getMonth() - 13, now.getDate()),
      capEndsAt: new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()),
      isActive: true,
    })

    const result = await onOrderPaid(renewal)

    expect(result.status).toBe("EXPIRED")
    expect(result.expired).toBe(true)
    expect(result.amount).toBe("0")
    const commission = state.commissions.at(-1)
    expect(commission?.status).toBe("EXPIRED")
    expect(String(commission?.amount)).toBe("0")
  })
})
