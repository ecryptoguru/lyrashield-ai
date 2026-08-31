import { createHash } from "node:crypto"
import { NextRequest } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"

const rateLimit = vi.hoisted(() => ({
  checkApiRateLimit: vi.fn(async () => ({ limited: false, remaining: 1 })),
  checkAuthRateLimit: vi.fn(),
  checkBillingWebhookRateLimit: vi.fn(),
  checkHealthRateLimit: vi.fn(),
  checkLiteScanRateLimit: vi.fn(),
}))

vi.mock("@lyrashield/config", () => ({ isDev: false }))
vi.mock("@lyrashield/affiliate", () => ({
  detectAttribution: vi.fn(),
  parseAffiliateCookie: vi.fn(),
}))
vi.mock("@/lib/billing-staging-access", () => ({ hasBillingStagingAccess: () => false }))
vi.mock("@/lib/scorecard-sharing", () => ({ scorecardTrackingAllowed: () => false }))
vi.mock("@/lib/rate-limit", () => rateLimit)

import { proxy } from "./proxy"

const certificate = "-----BEGIN CERTIFICATE-----\nAQIDBA==\n-----END CERTIFICATE-----"
const fingerprint = createHash("sha256")
  .update(Buffer.from([1, 2, 3, 4]))
  .digest("hex")
const originalEnv = { ...process.env }

afterEach(() => {
  vi.clearAllMocks()
  for (const key of [
    "CLOUDFLARE_ORIGIN_MTLS",
    "CLOUDFLARE_AOP_CERT_SHA256",
    "DEPLOY_PROBE_CERT_SHA256",
  ]) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

describe("app origin proxy boundary", () => {
  it("rejects a direct or spoofed app request before Redis-backed limiting", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"
    process.env.CLOUDFLARE_AOP_CERT_SHA256 = fingerprint
    process.env.DEPLOY_PROBE_CERT_SHA256 = "f".repeat(64)

    const response = await proxy(
      new NextRequest("https://app.lyrashieldai.com/api/billing/topup", {
        headers: { "cf-ipcountry": "IN", "x-lyrashield-trusted-country": "IN" },
      })
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(rateLimit.checkApiRateLimit).not.toHaveBeenCalled()
  })

  it("rejects the direct Azure origin when Authenticated Origin Pulls are required", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"

    const response = await proxy(
      new NextRequest(
        "https://lyrashield-app.icyglacier-d3526777.centralindia.azurecontainerapps.io/api/ready"
      )
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(rateLimit.checkHealthRateLimit).not.toHaveBeenCalled()
  })

  it("admits only a matching Cloudflare certificate before sanitizing country", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"
    process.env.CLOUDFLARE_AOP_CERT_SHA256 = fingerprint
    process.env.DEPLOY_PROBE_CERT_SHA256 = "f".repeat(64)

    const response = await proxy(
      new NextRequest("https://app.lyrashieldai.com/api/billing/topup", {
        headers: {
          "cf-ipcountry": "IN",
          "x-forwarded-client-cert": `Cert="${certificate.replace(/\n/g, "\\n")}"`,
        },
      })
    )

    expect(response.status).toBe(200)
    expect(rateLimit.checkApiRateLimit).toHaveBeenCalledOnce()
    expect(response.headers.get("x-middleware-request-x-lyrashield-trusted-country")).toBe("IN")
  })

  it("replaces a caller-supplied internal country with Cloudflare's country", async () => {
    process.env.CLOUDFLARE_ORIGIN_MTLS = "required"
    process.env.CLOUDFLARE_AOP_CERT_SHA256 = fingerprint
    process.env.DEPLOY_PROBE_CERT_SHA256 = "f".repeat(64)

    const response = await proxy(
      new NextRequest("https://app.lyrashieldai.com/api/billing/topup", {
        headers: {
          "cf-ipcountry": "US",
          "x-lyrashield-trusted-country": "IN",
          "x-forwarded-client-cert": `Cert="${certificate.replace(/\n/g, "\\n")}"`,
        },
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-request-x-lyrashield-trusted-country")).toBe("US")
  })
})
