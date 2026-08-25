import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const detectAttribution = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/affiliate", () => ({
  detectAttribution,
  parseAffiliateCookie: vi.fn().mockReturnValue(null),
}))

import { POST } from "./route"

describe("affiliate click privacy signals", () => {
  beforeEach(() => vi.clearAllMocks())

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
