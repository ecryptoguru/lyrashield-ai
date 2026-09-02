import { beforeEach, describe, expect, it, vi } from "vitest"

const hasReferralCode = vi.fn()
vi.mock("@lyrashield/db", () => ({ hasReferralCode }))

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
})
