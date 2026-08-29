import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

const secrets = vi.hoisted(() => ({
  current: "test-current-webhook-secret",
  previous: "test-previous-webhook-secret",
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    RAZORPAY_WEBHOOK_SECRET: secrets.current,
    RAZORPAY_WEBHOOK_PREVIOUS_SECRET: secrets.previous,
  },
}))

import { validateRazorpayWebhook } from "./webhooks"

describe("validateRazorpayWebhook", () => {
  const body = () =>
    JSON.stringify({
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_test", amount: 100, currency: "INR" } } },
    })

  it("accepts the current webhook secret", () => {
    const payload = body()
    const signature = createHmac("sha256", secrets.current).update(payload).digest("hex")

    expect(validateRazorpayWebhook(payload, signature)).toMatchObject({ event: "payment.captured" })
  })

  it("accepts the immediately previous secret for provider retries after rotation", () => {
    const payload = body()
    const signature = createHmac("sha256", secrets.previous).update(payload).digest("hex")

    expect(validateRazorpayWebhook(payload, signature)).toMatchObject({ event: "payment.captured" })
  })

  it("rejects an unrelated secret", () => {
    const payload = body()
    const signature = createHmac("sha256", "test-unrelated-webhook-secret")
      .update(payload)
      .digest("hex")

    expect(() => validateRazorpayWebhook(payload, signature)).toThrow(
      "Invalid Razorpay webhook signature"
    )
  })
})
