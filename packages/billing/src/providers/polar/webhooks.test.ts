import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

const testWebhook = vi.hoisted(() => {
  const key = Buffer.from("polar-sandbox-signing-key-32bytes", "utf8")
  return { key, secret: `whsec_${key.toString("base64")}` }
})

vi.mock("@lyrashield/config", () => ({
  env: { POLAR_WEBHOOK_SECRET: testWebhook.secret, POLAR_WEBHOOK_TOLERANCE_MS: 300_000 },
}))

import { validatePolarWebhook } from "./webhooks"

describe("validatePolarWebhook", () => {
  it("validates Standard Webhooks headers, an encoded endpoint secret, and a seconds timestamp", () => {
    const id = "msg_polar_smoke"
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"subscription.active","data":{"id":"sub_1"}}'
    const signature = createHmac("sha256", testWebhook.key)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")

    expect(
      validatePolarWebhook(body, {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      })
    ).toEqual({ type: "subscription.active", data: { id: "sub_1" } })
  })

  it("accepts Polar's legacy plural header aliases", () => {
    const id = "msg_polar_legacy"
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"order.paid","data":{"id":"ord_1"}}'
    const signature = createHmac("sha256", testWebhook.key)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")

    expect(
      validatePolarWebhook(body, {
        "webhooks-id": id,
        "webhooks-timestamp": timestamp,
        "webhooks-signature": `v1,${signature}`,
      })
    ).toMatchObject({ type: "order.paid" })
  })
})
