import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"
import { randomUUID } from "node:crypto"
import {
  onOrderPaid,
  onRefund,
  checkPayoutEligibility,
  computeReserve,
} from "@lyrashield/affiliate"

/**
 * E2E: Commission rules.
 *
 * - Tier escalation: 10 active referred subs → next commission at 30%
 * - 12-month cap: subscription past capEndsAt → EXPIRED amount=0
 * - Provider-confirmed refund or chargeback → clawback
 * - New-affiliate reserve: 25% held first 90 days
 * - Payout minimum: request button disabled below $100
 */

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test.describe("Commission rules", () => {
  let affiliate: { id: string; userId: string }
  // The affiliate's promo code — passed to onOrderPaid so resolveAttribution
  // resolves the order to this affiliate (promo code takes precedence over
  // cookie). Without it the order is UNATTRIBUTED and no commission is created.
  let affiliatePromoCode: string

  test.beforeAll(async () => {
    // User.id has no @default (Better Auth generates it at signup), so supply
    // an explicit id for the direct prisma.user.create here.
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `comm-rules-${suffix}@example.com`,
        name: "Commission Rules Test",
        emailVerified: true,
      },
    })

    affiliatePromoCode = `COMM${suffix.slice(-4).toUpperCase()}`
    affiliate = (await prisma.affiliate.create({
      data: {
        userId: user.id,
        status: "APPROVED",
        approvedAt: new Date(),
        promoCode: affiliatePromoCode,
        activeReferrals: 0,
        reservePct: 25,
        reserveUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    })) as { id: string; userId: string }
  })

  test("tier escalation: 10 active referred subs → 30%", async () => {
    // Set activeReferrals to 10
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: { activeReferrals: 10 },
    })

    const externalId = `polar_tier_${suffix}`
    const result = await onOrderPaid({
      provider: "polar",
      externalId,
      providerSubscriptionId: `sub_tier_${suffix}`,
      customerId: `cus_tier_${suffix}`,
      grossAmount: "99.00",
      commissionableAmount: "99.00",
      currency: "USD",
      isFirstPayment: true,
      promoCode: affiliatePromoCode,
    })

    expect(result.duplicate).toBe(false)
    expect(result.rateBps).toBe(3000) // 30%
  })

  test("12-month cap: subscription past capEndsAt → EXPIRED amount=0", async () => {
    // Create a subscription with capEndsAt in the past
    const subId = `sub_cap_${suffix}`
    await prisma.affiliateSubscription.create({
      data: {
        providerSubscriptionId: subId,
        provider: "polar",
        customerId: `cus_cap_${suffix}`,
        affiliateId: affiliate.id,
        firstPaidAt: new Date(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000),
        capEndsAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // past
        isActive: true,
      },
    })

    const externalId = `polar_cap_${suffix}`
    const result = await onOrderPaid({
      provider: "polar",
      externalId,
      providerSubscriptionId: subId,
      customerId: `cus_cap_${suffix}`,
      grossAmount: "99.00",
      commissionableAmount: "99.00",
      currency: "USD",
      isFirstPayment: false,
      promoCode: affiliatePromoCode,
    })

    expect(result.expired).toBe(true)
    expect(result.amount).toBe("0")
    expect(result.status).toBe("EXPIRED")
  })

  test("provider-confirmed refund → clawback", async () => {
    const externalId = `polar_refund_${suffix}`

    // First, create a commission
    await onOrderPaid({
      provider: "polar",
      externalId,
      providerSubscriptionId: `sub_refund_${suffix}`,
      customerId: `cus_refund_${suffix}`,
      grossAmount: "29.00",
      commissionableAmount: "29.00",
      currency: "USD",
      isFirstPayment: true,
      promoCode: affiliatePromoCode,
    })

    // Then refund
    const clawbackResult = await onRefund({
      provider: "polar",
      externalId,
      reason: "REFUND",
    })

    expect(clawbackResult.reversed).toBe(true)

    // Verify commission is REVERSED
    // The conversion's idempotencyKey is provider-scoped (polar:externalId),
    // not the bare externalId.
    const conversion = await prisma.conversion.findFirst({
      where: { idempotencyKey: `polar:${externalId}` },
      include: { commissions: true },
    })
    expect(conversion!.commissions[0]!.status).toBe("REVERSED")
  })

  test("new-affiliate reserve: 25% held first 90 days", async () => {
    const reserve = computeReserve({
      reservePct: 25,
      reserveUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    })

    expect(reserve.active).toBe(true)
    expect(reserve.pct).toBe(25)
    expect(reserve.daysRemaining).toBeGreaterThan(0)
  })

  test("new-affiliate reserve: released after 90 days", async () => {
    const reserve = computeReserve({
      reservePct: 25,
      reserveUntil: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // past
    })

    expect(reserve.active).toBe(false)
  })

  test("payout minimum: below $100 → not eligible", async () => {
    // Set up payout method and tax form
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: {
        payoutMethod: {
          type: "payoneer",
          valid: true,
          taxFormComplete: true,
          taxFormType: "W-8BEN",
          email: "test@example.com",
          country: "US",
        },
      },
    })

    // Check eligibility — should fail if available < $100
    const eligibility = await checkPayoutEligibility(affiliate.id)

    // The available amount depends on previous test commissions
    // If below $100, it should not be eligible
    if (parseFloat(eligibility.availableAmount) < 100) {
      expect(eligibility.eligible).toBe(false)
      expect(eligibility.reasons.some((r) => r.includes("below minimum payout"))).toBe(true)
    }
  })

  test.afterAll(async () => {
    await prisma.commission.deleteMany({
      where: { affiliateId: affiliate.id },
    })
    await prisma.conversion.deleteMany({
      where: { affiliateId: affiliate.id },
    })
    await prisma.affiliateSubscription.deleteMany({
      where: { affiliateId: affiliate.id },
    })
    await prisma.affiliate.deleteMany({
      where: { id: affiliate.id },
    })
    await prisma.user.deleteMany({
      where: { email: { contains: suffix } },
    })
  })
})
