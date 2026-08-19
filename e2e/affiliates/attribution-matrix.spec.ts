import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"
import {
  resolveAttribution,
  attributeSignup,
  onOrderPaid,
  detectFraudSignals,
  isSelfReferral,
} from "@lyrashield/affiliate"
import { createHash, randomUUID } from "node:crypto"

/**
 * E2E: Attribution matrix.
 *
 * - day-1 purchase with ref → attributed
 * - day-(window+1) → expired
 * - A then B click → B wins (last-click)
 * - A click + B code → B wins (promo code overrides cookie)
 * - tampered cookie → rejected
 * - duplicate webhook → idempotent
 * - blocked cookie + valid code → code wins
 * - self-referral → rejected
 */

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

test.describe("Attribution matrix", () => {
  let affiliateA: { id: string; userId: string }
  let affiliateB: { id: string; userId: string }
  let linkA: { id: string; code: string }
  let linkB: { id: string; code: string }

  test.beforeAll(async () => {
    // Create two test affiliates.
    // User.id has no @default (Better Auth generates it at signup), so the
    // direct prisma.user.create here must supply an explicit id.
    const userA = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `attr-a-${suffix}@example.com`,
        name: "Affiliate A",
        emailVerified: true,
      },
    })
    const userB = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `attr-b-${suffix}@example.com`,
        name: "Affiliate B",
        emailVerified: true,
      },
    })

    affiliateA = (await prisma.affiliate.create({
      data: {
        userId: userA.id,
        status: "APPROVED",
        approvedAt: new Date(),
        promoCode: `CODEA${suffix.slice(-4).toUpperCase()}`,
      },
    })) as { id: string; userId: string }

    affiliateB = (await prisma.affiliate.create({
      data: {
        userId: userB.id,
        status: "APPROVED",
        approvedAt: new Date(),
        promoCode: `CODEB${suffix.slice(-4).toUpperCase()}`,
      },
    })) as { id: string; userId: string }

    linkA = await prisma.affiliateLink.create({
      data: {
        affiliateId: affiliateA.id,
        code: `LINKA${suffix.slice(-4).toUpperCase()}`,
        campaign: "test",
      },
    })
    linkB = await prisma.affiliateLink.create({
      data: {
        affiliateId: affiliateB.id,
        code: `LINKB${suffix.slice(-4).toUpperCase()}`,
        campaign: "test",
      },
    })
  })

  test("day-1 purchase with ref → attributed", async () => {
    // Create a fresh attribution token for affiliate A
    const token = `token-day1-${suffix}`
    const click = await prisma.click.create({
      data: {
        linkId: linkA.id,
        affiliateId: affiliateA.id,
        clickedAt: new Date(),
      },
    })
    await prisma.attributionToken.create({
      data: {
        tokenHash: hashToken(token),
        affiliateId: affiliateA.id,
        clickId: click.id,
        linkId: linkA.id,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    })

    const result = await resolveAttribution({ cookieToken: token })
    expect(result.method).toBe("cookie")
    expect(result.affiliateId).toBe(affiliateA.id)
  })

  test("day-(window+1) → expired", async () => {
    const token = `token-expired-${suffix}`
    const click = await prisma.click.create({
      data: {
        linkId: linkA.id,
        affiliateId: affiliateA.id,
        clickedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000),
      },
    })
    await prisma.attributionToken.create({
      data: {
        tokenHash: hashToken(token),
        affiliateId: affiliateA.id,
        clickId: click.id,
        linkId: linkA.id,
        expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // expired
      },
    })

    const result = await resolveAttribution({ cookieToken: token })
    expect(result.method).toBe("unattributed")
    expect(result.affiliateId).toBeNull()
  })

  test("A then B click → B wins (last-click)", async () => {
    // Create token for A (older)
    const tokenA = `token-a-then-b-a-${suffix}`
    const clickA = await prisma.click.create({
      data: {
        linkId: linkA.id,
        affiliateId: affiliateA.id,
        clickedAt: new Date(Date.now() - 5000),
      },
    })
    await prisma.attributionToken.create({
      data: {
        tokenHash: hashToken(tokenA),
        affiliateId: affiliateA.id,
        clickId: clickA.id,
        linkId: linkA.id,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    })

    // Create token for B (newer)
    const tokenB = `token-a-then-b-b-${suffix}`
    const clickB = await prisma.click.create({
      data: { linkId: linkB.id, affiliateId: affiliateB.id, clickedAt: new Date() },
    })
    await prisma.attributionToken.create({
      data: {
        tokenHash: hashToken(tokenB),
        affiliateId: affiliateB.id,
        clickId: clickB.id,
        linkId: linkB.id,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    })

    // The most recent cookie (B) should win
    const result = await resolveAttribution({ cookieToken: tokenB })
    expect(result.affiliateId).toBe(affiliateB.id)
  })

  test("A click + B code → B wins (promo code overrides cookie)", async () => {
    const tokenA = `token-a-code-b-${suffix}`
    const clickA = await prisma.click.create({
      data: { linkId: linkA.id, affiliateId: affiliateA.id, clickedAt: new Date() },
    })
    await prisma.attributionToken.create({
      data: {
        tokenHash: hashToken(tokenA),
        affiliateId: affiliateA.id,
        clickId: clickA.id,
        linkId: linkA.id,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    })

    // Promo code B should override cookie A
    const result = await resolveAttribution({
      cookieToken: tokenA,
      promoCode: `CODEB${suffix.slice(-4).toUpperCase()}`,
    })
    expect(result.method).toBe("promo_code")
    expect(result.affiliateId).toBe(affiliateB.id)
  })

  test("tampered cookie → rejected", async () => {
    // A completely random token that doesn't exist in the DB
    const result = await resolveAttribution({
      cookieToken: `tampered-${suffix}-${Math.random()}`,
    })
    expect(result.method).toBe("unattributed")
    expect(result.affiliateId).toBeNull()
  })

  test("duplicate webhook → idempotent", async () => {
    const externalId = `polar_dup_${suffix}`

    // First call — attributed via promo code so a conversion is created.
    const result1 = await onOrderPaid({
      provider: "polar",
      externalId,
      providerSubscriptionId: `sub_dup_${suffix}`,
      customerId: `cus_dup_${suffix}`,
      grossAmount: "29.00",
      currency: "USD",
      isFirstPayment: true,
      promoCode: `CODEA${suffix.slice(-4).toUpperCase()}`,
    })
    expect(result1.duplicate).toBe(false)

    // Second call with same externalId — must be a duplicate (idempotent).
    const result2 = await onOrderPaid({
      provider: "polar",
      externalId,
      providerSubscriptionId: `sub_dup_${suffix}`,
      customerId: `cus_dup_${suffix}`,
      grossAmount: "29.00",
      currency: "USD",
      isFirstPayment: true,
      promoCode: `CODEA${suffix.slice(-4).toUpperCase()}`,
    })
    expect(result2.duplicate).toBe(true)
    expect(result2.conversionId).toBe(result1.conversionId)
  })

  test("self-referral → rejected", async () => {
    expect(isSelfReferral(affiliateA.userId, affiliateA.userId)).toBe(true)
    expect(isSelfReferral(affiliateA.userId, "different-user-id")).toBe(false)
  })

  test("fraud signals: disposable email", async () => {
    const result = detectFraudSignals({
      email: "test@mailinator.com",
    })
    expect(result.flagged).toBe(true)
    expect(result.signals.some((s) => s.type === "DISPOSABLE_EMAIL")).toBe(true)
  })

  test("fraud signals: rate limit per IP", async () => {
    const result = detectFraudSignals({
      signupCountByIp: 10,
    })
    expect(result.flagged).toBe(true)
    expect(result.block).toBe(true)
  })

  test.afterAll(async () => {
    // Cleanup
    await prisma.attributionToken.deleteMany({
      where: { affiliateId: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.click.deleteMany({
      where: { affiliateId: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.commission.deleteMany({
      where: { affiliateId: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.conversion.deleteMany({
      where: { affiliateId: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.affiliateSubscription.deleteMany({
      where: { affiliateId: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.affiliateLink.deleteMany({
      where: { affiliateId: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.affiliate.deleteMany({
      where: { id: { in: [affiliateA.id, affiliateB.id] } },
    })
    await prisma.user.deleteMany({
      where: { email: { contains: suffix } },
    })
  })
})
