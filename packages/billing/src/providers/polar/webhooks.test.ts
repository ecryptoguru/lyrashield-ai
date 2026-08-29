import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { env } from "@lyrashield/config"

const testWebhook = vi.hoisted(() => {
  const secret = "whsec_polar-sandbox-signing-key-32bytes"
  return { key: Buffer.from(secret, "utf8"), secret }
})

vi.mock("@lyrashield/config", () => ({
  env: { POLAR_WEBHOOK_SECRET: testWebhook.secret, POLAR_WEBHOOK_TOLERANCE_MS: 300_000 },
}))

import { validatePolarWebhook } from "./webhooks"

describe("validatePolarWebhook", () => {
  it("validates Standard Webhooks headers, Polar's raw endpoint secret, and a seconds timestamp", () => {
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

  it("uses the displayed whsec_ secret as raw HMAC key material", () => {
    const id = "msg_polar_raw_secret"
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"order.paid","data":{"id":"ord_2"}}'
    const rawSecret = `whsec_${["endpoint", "secret", "is", "not", "base64", "key", "material"].join("-")}`
    const key = Buffer.from(rawSecret, "utf8")
    const signature = createHmac("sha256", key)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")

    const originalSecret = env.POLAR_WEBHOOK_SECRET
    env.POLAR_WEBHOOK_SECRET = rawSecret
    try {
      expect(
        validatePolarWebhook(body, {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${signature}`,
        })
      ).toMatchObject({ type: "order.paid" })
    } finally {
      env.POLAR_WEBHOOK_SECRET = originalSecret
    }
  })

  it("accepts unpadded Base64URL Standard Webhooks signatures", () => {
    const id = "msg_polar_base64url"
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = '{"type":"order.paid","data":{"id":"ord_3"}}'
    const signature = createHmac("sha256", testWebhook.key)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

    expect(
      validatePolarWebhook(body, {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      })
    ).toMatchObject({ type: "order.paid" })
  })
})
