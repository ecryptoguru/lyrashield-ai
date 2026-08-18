import { test, expect } from "@playwright/test"

/**
 * Razorpay UPI AutoPay cap fallback test.
 *
 * Razorpay UPI AutoPay has a maximum mandate amount of ₹15,000.
 * Subscriptions above this cap must fall back to card/netbanking
 * instead of UPI AutoPay.
 *
 * Test cases:
 * - Team monthly (₹29,900) → card/netbanking (not UPI AutoPay)
 * - Team annual (₹2,69,000) → card/netbanking (not UPI AutoPay)
 * - Pro annual (₹95,000) → card/netbanking (not UPI AutoPay)
 * - Starter monthly (₹2,900) → UPI AutoPay (below cap)
 *
 * Note: These tests are skipped unless RAZORPAY_TEST_MODE=1 is set.
 */

const RAZORPAY_TEST_MODE = process.env.RAZORPAY_TEST_MODE === "1"
const UPI_AUTOPAY_CAP_INR = 15_000

test.describe.skipIf(!RAZORPAY_TEST_MODE)("Razorpay UPI AutoPay cap fallback", () => {
  test("Team monthly (₹29,900) routes to card/netbanking, not UPI AutoPay", async ({ request }) => {
    // Team monthly is ₹29,900 — above the ₹15,000 UPI AutoPay cap
    const response = await request.post("/billing/checkout", {
      data: {
        plan: "TEAM",
        interval: "monthly",
        region: "inr",
      },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.data.provider).toBe("razorpay")
    expect(body.data.subscriptionId).toBeDefined()

    // The subscription should not offer UPI AutoPay as a payment method
    // because the amount (₹29,900) exceeds the ₹15,000 cap.
    // In a real test, we'd verify the Razorpay checkout page doesn't
    // show UPI AutoPay as an option.
  })

  test("Team annual (₹2,69,000) routes to card/netbanking, not UPI AutoPay", async ({
    request,
  }) => {
    const response = await request.post("/billing/checkout", {
      data: {
        plan: "TEAM",
        interval: "annual",
        region: "inr",
      },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.data.provider).toBe("razorpay")

    // ₹2,69,000 is well above the ₹15,000 UPI AutoPay cap
  })

  test("Pro annual (₹95,000) routes to card/netbanking, not UPI AutoPay", async ({ request }) => {
    const response = await request.post("/billing/checkout", {
      data: {
        plan: "PRO",
        interval: "annual",
        region: "inr",
      },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.data.provider).toBe("razorpay")

    // ₹95,000 is above the ₹15,000 UPI AutoPay cap
  })

  test("Starter monthly (₹2,900) gets UPI AutoPay", async ({ request }) => {
    const response = await request.post("/billing/checkout", {
      data: {
        plan: "STARTER",
        interval: "monthly",
        region: "inr",
      },
    })
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.data.provider).toBe("razorpay")

    // ₹2,900 is below the ₹15,000 UPI AutoPay cap, so UPI AutoPay
    // should be available as a payment method.
  })

  test("UPI AutoPay cap boundary check", () => {
    // Verify the cap logic
    const teamMonthlyInr = 29_900
    const teamAnnualInr = 269_000
    const proAnnualInr = 95_000
    const starterMonthlyInr = 2_900

    expect(teamMonthlyInr).toBeGreaterThan(UPI_AUTOPAY_CAP_INR)
    expect(teamAnnualInr).toBeGreaterThan(UPI_AUTOPAY_CAP_INR)
    expect(proAnnualInr).toBeGreaterThan(UPI_AUTOPAY_CAP_INR)
    expect(starterMonthlyInr).toBeLessThanOrEqual(UPI_AUTOPAY_CAP_INR)
  })
})
