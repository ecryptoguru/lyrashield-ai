import { beforeEach, describe, expect, it, vi } from "vitest"

const attributeReferral = vi.fn()
const getSession = vi.fn()
const getClientIP = vi.fn()
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
const cookieStore = {
  get: vi.fn(),
  delete: vi.fn(),
}

vi.mock("@lyrashield/db", () => ({ attributeReferral }))
vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long" },
}))
vi.mock("@/proxy", () => ({ getClientIP }))
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue(cookieStore) }))
vi.mock("@/lib/analytics-preference", () => ({
  analyticsAllowedForRequest,
  clearOptionalTrackingCookies,
}))

const { POST } = await import("./route")

describe("POST /api/referrals/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "new-user" })
    analyticsAllowedForRequest.mockImplementation(async (request: Request) => {
      const dnt = request.headers.get("dnt")?.toLowerCase()
      return (
        !["1", "yes"].includes(dnt ?? "") &&
        request.headers.get("sec-gpc") !== "1" &&
        !request.headers
          .get("cookie")
          ?.split(";")
          .some((part) => part.trim() === "lyrashield-analytics=off")
      )
    })
    getClientIP.mockReturnValue("203.0.113.1")
    cookieStore.get.mockImplementation((name: string) =>
      name === "ls_ref"
        ? { value: "23456789" }
        : name === "ls_ref_source"
          ? { value: "linkedin" }
          : undefined
    )
    attributeReferral.mockResolvedValue({ id: "attribution-1" })
  })

  it("claims referral and clears both continuity cookies", async () => {
    const response = await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(response.status).toBe(200)
    expect(attributeReferral).toHaveBeenCalledWith(
      "23456789",
      "new-user",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "linkedin"
    )
    expect(cookieStore.delete.mock.calls).toEqual([["ls_ref"], ["ls_ref_source"]])
  })

  it("requires authentication and leaves cookies untouched", async () => {
    getSession.mockResolvedValue(null)
    const response = await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(response.status).toBe(401)
    expect(attributeReferral).not.toHaveBeenCalled()
    expect(cookieStore.delete).not.toHaveBeenCalled()
  })

  it.each([
    { apiKey: { keyId: "k-1", workspaceId: "ws-1", scopes: ["read", "write"], prefix: "lsk_x" } },
    { oauth: { userId: "new-user", workspaceId: "ws-1", scopes: ["lyrashield.write"] } },
  ])(
    "rejects workspace-bound credentials — referral attribution is browser-owned",
    async (credential) => {
      getSession.mockResolvedValue({ userId: "new-user", ...credential })

      const response = await POST(new Request("http://localhost/api/referrals/claim") as never)

      expect(response.status).toBe(403)
      expect(attributeReferral).not.toHaveBeenCalled()
      expect(cookieStore.delete).not.toHaveBeenCalled()
    }
  )

  it("does nothing without a referral cookie", async () => {
    cookieStore.get.mockReturnValue(undefined)
    const response = await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { attributed: false } })
    expect(attributeReferral).not.toHaveBeenCalled()
  })

  it("does not persist a forged referral source", async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === "ls_ref" ? { value: "23456789" } : { value: "private-target" }
    )
    await POST(new Request("http://localhost/api/referrals/claim") as never)
    expect(attributeReferral).toHaveBeenCalledWith(
      "23456789",
      "new-user",
      expect.any(String),
      "scorecard"
    )
  })

  it("leaves referral rewards unchanged and clears pending cookies when analytics is off", async () => {
    analyticsAllowedForRequest.mockResolvedValue(false)
    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/referrals/claim") as never
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { attributed: false } })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(attributeReferral).not.toHaveBeenCalled()
    expect(cookieStore.delete).not.toHaveBeenCalled()
    const cookies = response.headers.getSetCookie().join(";")
    for (const name of optionalTrackingCookies) expect(cookies).toContain(`${name}=`)
  })
})
