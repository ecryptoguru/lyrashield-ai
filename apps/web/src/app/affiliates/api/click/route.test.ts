import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { NextRequest } from "next/server"

const detectAttribution = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/affiliate", () => ({
  detectAttribution,
  parseAffiliateCookie: vi.fn().mockReturnValue(null),
}))

import { POST } from "./route"

describe("affiliate click privacy signals", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllEnvs())

  it("uses the trusted final hop despite spoofed affiliate IP headers", async () => {
    vi.stubEnv("TRUSTED_PROXY_IP_HEADER", "x-forwarded-for")
    vi.stubEnv("IP_HASH_SALT", "affiliate-test")
    detectAttribution.mockResolvedValue({ attributed: false })
    const response = await POST(
      new NextRequest("https://app.example.com/affiliates/api/click", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0",
          "x-forwarded-for": "spoofed, 203.0.113.8",
          "cf-connecting-ip": "spoofed-too",
        },
        body: JSON.stringify({ code: "CODE1234" }),
      })
    )
    expect(response.status).toBe(200)
    expect(detectAttribution).toHaveBeenCalledWith(
      expect.objectContaining({
        ipHash: createHash("sha256").update("203.0.113.8affiliate-test").digest("hex"),
      })
    )
  })

  it.each([
    ["DNT", { dnt: "1" }],
    ["GPC", { "sec-gpc": "1" }],
  ])("suppresses async referral capture when %s is enabled", async (_signal, headers) => {
    const request = new NextRequest("https://app.example.com/affiliates/api/click", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", ...headers },
      body: JSON.stringify({ code: "CODE1234" }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: false, suppressed: true })
    expect(detectAttribution).not.toHaveBeenCalled()
  })
})
