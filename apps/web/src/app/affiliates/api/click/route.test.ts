import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The click route must not reach attribution or the database while new
// admission is frozen. Both are mocked to fail loudly if they are called.
vi.mock("@lyrashield/affiliate", () => ({
  detectAttribution: vi.fn(() => {
    throw new Error("detectAttribution must not run while admission is frozen")
  }),
  parseAffiliateCookie: vi.fn(() => {
    throw new Error("parseAffiliateCookie must not run while admission is frozen")
  }),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    click: {
      create: vi.fn(() => {
        throw new Error("Click must not be created while admission is frozen")
      }),
    },
    attributionToken: {
      create: vi.fn(() => {
        throw new Error("AttributionToken must not be created while admission is frozen")
      }),
    },
  },
}))

import { POST } from "./route"

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://app.example.com/affiliates/api/click", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", ...headers },
    body: JSON.stringify({ code: "CODE1234" }),
  })
}

describe("affiliate click capture — closed", () => {
  it("answers closed without recording a click", async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: false, closed: true })
  })

  it("sets no attribution cookie", async () => {
    const response = await POST(request())

    expect(response.headers.get("Set-Cookie")).toBeNull()
  })

  it("stays closed for a request that previously recorded a click", async () => {
    // A normal browser request with a referral code is the exact case that used
    // to create a Click and return an affiliateId.
    const response = await POST(request({ referer: "https://example.com/blog" }))

    expect(await response.json()).toEqual({ success: false, closed: true })
    expect(response.headers.get("Set-Cookie")).toBeNull()
  })
})
