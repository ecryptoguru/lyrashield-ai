import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: {
    TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
    BILLING_GEO_IP_HEADER: "cf-connecting-ip",
  },
}))

import { resolveProvider } from "./geo"

function spoofedIndiaRequest() {
  return new Request("https://example.invalid/billing/checkout", {
    headers: { "x-forwarded-for": "192.0.2.44", "cf-ipcountry": "IN" },
  })
}

function trustedIndiaRequest() {
  return new Request("https://app.lyrashieldai.com/billing/checkout", {
    headers: { "x-lyrashield-trusted-country": "IN" },
  })
}

describe("billing provider region resolution", () => {
  it("ignores client-controlled forwarding and country headers", () => {
    expect(resolveProvider(spoofedIndiaRequest())).toEqual({
      provider: "polar",
      region: "usd",
    })
  })

  it("uses only the proxy-authenticated India country marker", () => {
    expect(resolveProvider(trustedIndiaRequest())).toEqual({ provider: "razorpay", region: "inr" })
    expect(resolveProvider(new Request("https://app.lyrashieldai.com"))).toEqual({
      provider: "polar",
      region: "usd",
    })
  })
})
