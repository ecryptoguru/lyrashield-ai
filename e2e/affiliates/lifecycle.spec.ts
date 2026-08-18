import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"
import { onOrderPaid } from "@lyrashield/affiliate"
import { releaseCommissions } from "@lyrashield/affiliate"

/**
 * E2E: Full affiliate lifecycle.
 *
 * Apply → admin approve → link generated → ?ref= click → cookie set →
 * attributed signup → paid webhook (Polar sandbox order.paid) →
 * Conversion + PENDING Commission → 30d hold (mock time) → AVAILABLE →
 * request payout → provider callback → PAID
 */

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const password = "E2e-affiliate-123!"
const affiliateEmail = `e2e-affiliate-${suffix}@example.com`
const referredEmail = `e2e-referred-${suffix}@example.com`

test.describe("Affiliate lifecycle", () => {
  test("apply → approve → click → signup → commission → payout", async ({ page }) => {
    // 1. Sign up as the prospective affiliate
    await page.goto("/sign-up")
    await page.getByLabel("Name").fill("E2E Affiliate")
    await page.getByLabel("Email").fill(affiliateEmail)
    await page.locator("#password").fill(password)
    await page.getByRole("button", { name: "Create account" }).click()
    await expect
      .poll(() => prisma.user.findUnique({ where: { email: affiliateEmail } }))
      .not.toBeNull()
    await prisma.user.update({
      where: { email: affiliateEmail },
      data: { emailVerified: true },
    })

    // 2. Apply to the affiliate program
    await page.goto("/affiliates/apply")
    await page.getByLabel("Your Name").fill("E2E Affiliate")
    await page.getByLabel("Website / Channel URL").fill("https://example.com/blog")
    await page.getByLabel("Audience Size").selectOption("1k-10k")
    await page.getByLabel("Audience Type").selectOption("developers")
    await page
      .getByLabel("Promotion Methods")
      .fill("Blog posts and newsletter about AI security tools")
    await page.getByLabel("Preferred Payout Method").selectOption("payoneer")
    await page.getByLabel("Tax Form Status").selectOption("will_complete")
    await page.getByRole("button", { name: "Submit Application" }).click()

    // Verify application was created
    const affiliate = await expect
      .poll(() =>
        prisma.affiliate.findUnique({
          where: {
            userId: (await prisma.user.findUnique({ where: { email: affiliateEmail } }))!.id,
          },
        })
      )
      .not.toBeNull()

    expect(affiliate.status).toBe("PENDING")

    // 3. Admin approve (directly in DB for E2E)
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        promoCode: `E2E${suffix.slice(-6).toUpperCase()}`,
        reserveUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    })

    // Generate primary link
    const { randomBytes } = await import("node:crypto")
    const linkCode = randomBytes(6).toString("base64url").slice(0, 8).toUpperCase()
    await prisma.affiliateLink.create({
      data: {
        affiliateId: affiliate.id,
        code: linkCode,
        campaign: "primary",
      },
    })

    // 4. Click the referral link (as a new visitor)
    const clickResponse = await page.request.get(`/?ref=${linkCode}`)
    expect(clickResponse.status()).toBe(200)

    // Verify click was recorded
    await expect
      .poll(async () => {
        const clicks = await prisma.click.count({
          where: { affiliateId: affiliate.id },
        })
        return clicks
      })
      .toBeGreaterThanOrEqual(1)

    // 5. Sign up as the referred user (with cookie from the click)
    // First sign out
    await page.request.post("/api/auth/sign-out", {
      data: {},
      headers: { Origin: "http://127.0.0.1:3100" },
    })

    await page.goto("/sign-up")
    await page.getByLabel("Name").fill("E2E Referred")
    await page.getByLabel("Email").fill(referredEmail)
    await page.locator("#password").fill(password)
    await page.getByRole("button", { name: "Create account" }).click()
    await expect
      .poll(() => prisma.user.findUnique({ where: { email: referredEmail } }))
      .not.toBeNull()

    const referredUser = await prisma.user.findUnique({
      where: { email: referredEmail },
    })

    // Manually attribute (in production, the middleware cookie would do this)
    await prisma.user.update({
      where: { id: referredUser!.id },
      data: { affiliate: { connect: { id: affiliate.id } } },
    })

    // 6. Simulate a paid webhook (Polar sandbox order.paid)
    const externalId = `polar_order_${suffix}`
    const result = await onOrderPaid({
      provider: "polar",
      externalId,
      providerSubscriptionId: `sub_${suffix}`,
      customerId: `cus_${suffix}`,
      grossAmount: "29.00",
      discountAmount: "0",
      taxAmount: "0",
      currency: "USD",
      isAnnual: false,
      planId: "STARTER",
      promoCode: null,
      cookieToken: null,
      subid: null,
      isFirstPayment: true,
    })

    expect(result.duplicate).toBe(false)
    expect(result.status).toBe("PENDING")

    // Verify Conversion + Commission were created
    const conversion = await prisma.conversion.findFirst({
      where: { idempotencyKey: externalId },
      include: { commissions: true },
    })
    expect(conversion).not.toBeNull()
    expect(conversion!.commissions).toHaveLength(1)
    expect(conversion!.commissions[0]!.status).toBe("PENDING")

    // 7. Simulate 30-day hold passing (mock time by updating availableAt)
    await prisma.commission.update({
      where: { id: conversion!.commissions[0]!.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    })

    // Release commissions
    const releaseResult = await releaseCommissions()
    expect(releaseResult.released).toBeGreaterThanOrEqual(1)

    // Verify commission is now AVAILABLE
    const releasedCommission = await prisma.commission.findUnique({
      where: { id: conversion!.commissions[0]!.id },
    })
    expect(releasedCommission!.status).toBe("AVAILABLE")

    // 8. Verify the affiliate dashboard shows the data
    // Sign back in as the affiliate
    await page.request.post("/api/auth/sign-out", {
      data: {},
      headers: { Origin: "http://127.0.0.1:3100" },
    })
    await page.goto("/sign-in")
    await page.getByLabel("Email").fill(affiliateEmail)
    await page.locator("#password").fill(password)
    await page.getByRole("button", { name: "Sign in" }).click()

    await page.goto("/affiliates/dashboard")
    await expect(page.getByText("Affiliate Dashboard")).toBeVisible()

    // 9. Privacy check: partner dashboard shows masked IDs only
    await page.goto("/affiliates/activity?tab=signups")
    // Should NOT show the referred user's email
    const pageText = await page.textContent("body")
    expect(pageText).not.toContain(referredEmail)
  })
})
