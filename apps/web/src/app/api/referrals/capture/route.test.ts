import { beforeEach, describe, expect, it, vi } from "vitest"

const hasReferralCode = vi.fn()
const analyticsAllowedForRequest = vi.fn()
const optionalTrackingCookies = [
  "lyrashield-acq",
  "ls_ref",
  "ls_ref_source",
  "ls_scorecard_visitor",
]
const clearOptionalTrackingCookies = vi.fn((response: Response, request: Request) => {
  const url = new URL(request.url)
  const secure = url.protocol === "https:"
  const canonical = ["lyrashieldai.com", "www.lyrashieldai.com", "app.lyrashieldai.com"].includes(
    url.hostname
  )
  for (const name of optionalTrackingCookies) {
    const domains = ["", ...(canonical ? ["; Domain=.lyrashieldai.com"] : [])]
    for (const domain of domains) {
      response.headers.append(
        "Set-Cookie",
        `${name}=; Path=/; Max-Age=0; SameSite=Lax${domain}${secure ? "; Secure" : ""}`
      )
    }
  }
})
vi.mock("@lyrashield/db", () => ({ hasReferralCode }))
vi.mock("@lyrashield/config", () => ({
  env: { NEXT_PUBLIC_APP_URL: "http://localhost" },
  isProd: false,
}))
vi.mock("@/lib/analytics-preference", () => ({
  analyticsAllowedForRequest,
  clearOptionalTrackingCookies,
}))

const { POST } = await import("./route")

function request(body: unknown) {
  return new Request("http://localhost/api/referrals/capture", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/referrals/capture", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasReferralCode.mockResolvedValue(true)
    analyticsAllowedForRequest.mockResolvedValue(true)
  })

  it("stores an allowlisted attribution source in an HttpOnly cookie", async () => {
    const response = await POST(request({ code: "23456789", source: "linkedin" }))
    expect(response.status).toBe(200)
    const cookies = response.headers.getSetCookie().join(";")
    expect(cookies).toContain("ls_ref=23456789")
    expect(cookies).toContain("ls_ref_source=linkedin")
    expect(cookies).toContain("HttpOnly")
    expect(cookies).toContain("SameSite=strict")
  })

  it("rejects unknown attribution sources", async () => {
    expect((await POST(request({ code: "23456789", source: "private-url" }))).status).toBe(400)
    expect(hasReferralCode).not.toHaveBeenCalled()
  })

  it("rejects cross-site planting before looking up a referral", async () => {
    const req = request({ code: "23456789" })
    req.headers.set("sec-fetch-site", "cross-site")
    req.headers.set("origin", "https://evil.example")
    const response = await POST(req)
    expect(response.status).toBe(403)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(hasReferralCode).not.toHaveBeenCalled()
  })

  it("does not capture referral cookies while optional analytics are disabled", async () => {
    analyticsAllowedForRequest.mockResolvedValue(false)
    const response = await POST(request({ code: "23456789" }))
    expect(response.status).toBe(204)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(hasReferralCode).not.toHaveBeenCalled()
    expect(clearOptionalTrackingCookies).toHaveBeenCalledOnce()
    const cookies = response.headers.getSetCookie().join(";")
    for (const name of optionalTrackingCookies) expect(cookies).toContain(`${name}=`)
  })
})
