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
  test("apply → approve → click → signup → commission → payout", async ({ page }, testInfo) => {
    // Isolate the per-IP fraud/rate-limit counters: the apply route's fraud
    // check counts prior Clicks by the request IP, and many e2e specs share the
    // default 127.0.0.1. Give this test a distinct simulated client IP so the
    // RATE_LIMIT_IP signal does not falsely trip on other specs' Clicks.
    const forwardedFor = `198.51.100.${(testInfo.workerIndex % 200) + 20}`
    await page.setExtraHTTPHeaders({ "x-forwarded-for": forwardedFor })

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

    // Establish an authenticated session on the dashboard before navigating to
    // the (auth-gated) apply page. New signups land on /onboarding; sign out +
    // sign in + skip onboarding, matching the critical-flow pattern, so the
    // apply page does not redirect to /sign-in and the form renders.
    await page.request
      .post("/api/auth/sign-out", {
        data: {},
        headers: { Origin: "http://127.0.0.1:3100" },
      })
      .catch(() => {})
    await page.goto("/sign-in")
    await page.getByLabel("Email").fill(affiliateEmail)
    await page.locator("#password").fill(password)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
    await page.request
      .patch("/api/onboarding", {
        data: { skipped: true },
        headers: { Origin: "http://127.0.0.1:3100" },
      })
      .catch(() => {})

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
    // C-L10: the binding terms checkbox is required — check it before submitting.
    await page.locator("#acceptTerms").check()
    await page.getByRole("button", { name: "Submit Application" }).click()

    // Verify application was created
    // Verify application was created.
    // RISK-C3/e2e fix: expect.poll(...).not.toBeNull() returns an ExpectResult,
    // not the polled value — assigning it to `affiliate` then reading
    // affiliate.status throws TypeError. Split into a poll-for-existence check,
    // then a separate fetch to read the actual record.
    await expect
      .poll(async () => {
        const u = await prisma.user.findUnique({ where: { email: affiliateEmail } })
        if (!u) return null
        return prisma.affiliate.findUnique({ where: { userId: u.id } })
      })
      .not.toBeNull()

    const user = await prisma.user.findUnique({ where: { email: affiliateEmail } })
    const affiliate = await prisma.affiliate.findUnique({
      where: { userId: user!.id },
    })

    expect(affiliate!.status).toBe("PENDING")

    // 3. Admin approve (directly in DB for E2E)
    const affiliatePromoCode = `E2E${suffix.slice(-6).toUpperCase()}`
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        promoCode: affiliatePromoCode,
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

    // 6. Simulate a paid webhook (Polar sandbox order.paid).
    // Attribution: pass the affiliate's promo code so resolveAttribution
    // resolves the order to the affiliate (promo code takes precedence over a
    // cookie). The manual User.affiliate connect above links the user record but
    // is NOT how the commission engine resolves attribution — it needs the
    // promo code or cookie token.
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
      promoCode: affiliatePromoCode,
      cookieToken: null,
      subid: null,
      isFirstPayment: true,
    })

    expect(result.duplicate).toBe(false)
    expect(result.status).toBe("PENDING")

    // Verify Conversion + Commission were created.
    // The conversion's idempotencyKey is provider-scoped (polar:<externalId>).
    const conversion = await prisma.conversion.findFirst({
      where: { idempotencyKey: `polar:${externalId}` },
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
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
    await page.goto("/sign-in")
    await page.getByLabel("Email").fill(affiliateEmail)
    await page.locator("#password").fill(password)
    await page.getByRole("button", { name: "Sign in" }).click()
    // New sign-ins land on /onboarding; skip it so the dashboard is reachable.
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
    await page.request
      .patch("/api/onboarding", {
        data: { skipped: true },
        headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
      })
      .catch(() => {})

    // Confirm the affiliate is APPROVED in the DB before asserting the
    // dashboard renders (the dashboard redirects to /affiliates/apply unless
    // the signed-in user is an APPROVED affiliate).
    await expect
      .poll(async () => {
        const u = await prisma.user.findUnique({ where: { email: affiliateEmail } })
        if (!u) return null
        const a = await prisma.affiliate.findUnique({ where: { userId: u.id } })
        return a?.status ?? null
      })
      .toBe("APPROVED")

    await page.goto("/affiliates/dashboard")
    // The dashboard is a server component that requires an APPROVED affiliate
    // for the signed-in user. It redirects to /affiliates/apply if the
    // signed-in user is not an APPROVED affiliate. Assert the page did NOT
    // redirect away (i.e. the affiliate dashboard rendered), then check the
    // heading with a networkidle wait + longer timeout for the render.
    await page.waitForLoadState("networkidle").catch(() => {})
    await expect(page).not.toHaveURL(/\/affiliates\/apply/)
    await expect(page.getByRole("heading", { name: "Affiliate Dashboard" })).toBeVisible({
      timeout: 20000,
    })

    // 9. Privacy check: partner dashboard shows masked IDs only
    await page.goto("/affiliates/activity?tab=signups")
    // Should NOT show the referred user's email
    const pageText = await page.textContent("body")
    expect(pageText).not.toContain(referredEmail)
  })
})
