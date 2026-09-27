import { beforeEach, describe, expect, it, vi } from "vitest"

const { findUnique, getSession, withAccountRLS } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getSession: vi.fn(),
  withAccountRLS: vi.fn(),
}))

withAccountRLS.mockImplementation((_accountId: string, callback: (tx: unknown) => unknown) =>
  callback({ accountPreference: { findUnique } })
)

vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/db", () => ({ withAccountRLS }))

import {
  analyticsAllowedForRequest,
  clearOptionalTrackingCookies,
  OPTIONAL_TRACKING_COOKIES,
} from "./analytics-preference"

function request(headers: Record<string, string> = {}) {
  return new Request("https://app.lyrashieldai.com/api/scorecards/events", { headers })
}

describe("analyticsAllowedForRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue(null)
    findUnique.mockResolvedValue(null)
  })

  it("defaults anonymous visitors and missing authenticated rows to enabled", async () => {
    expect(await analyticsAllowedForRequest(request())).toBe(true)
    getSession.mockResolvedValue({ userId: "account-1" })
    expect(await analyticsAllowedForRequest(request())).toBe(true)
    expect(withAccountRLS).toHaveBeenCalledWith("account-1", expect.any(Function))
    expect(findUnique).toHaveBeenCalledWith({
      where: { accountId: "account-1" },
      select: { analyticsEnabled: true },
    })
  })

  it("uses only the authenticated account preference, without a workspace", async () => {
    getSession.mockResolvedValue({ userId: "account-1" })
    findUnique.mockResolvedValue({ analyticsEnabled: false })
    expect(await analyticsAllowedForRequest(request())).toBe(false)
    expect(withAccountRLS).toHaveBeenCalledWith("account-1", expect.any(Function))
  })

  it.each(["API key", "OAuth bearer"])("suppresses non-browser %s sessions", async (kind) => {
    getSession.mockResolvedValue({
      userId: "account-1",
      ...(kind === "API key" ? { apiKey: { keyId: "key-1" } } : { oauth: { userId: "account-1" } }),
    })
    expect(await analyticsAllowedForRequest(request())).toBe(false)
    expect(withAccountRLS).not.toHaveBeenCalled()
  })

  it.each([
    ["DNT", { dnt: "1" }],
    ["case-insensitive DNT", { dnt: "YES" }],
    ["GPC", { "sec-gpc": "1" }],
    ["browser preference", { cookie: "other=value; lyrashield-analytics=off" }],
  ])("blocks %s before reading account state", async (_name, headers) => {
    getSession.mockResolvedValue({ userId: "account-1" })
    expect(await analyticsAllowedForRequest(request(headers))).toBe(false)
    expect(getSession).not.toHaveBeenCalled()
    expect(withAccountRLS).not.toHaveBeenCalled()
  })

  it("fails closed when an authenticated account preference cannot be read", async () => {
    getSession.mockResolvedValue({ userId: "account-1" })
    withAccountRLS.mockRejectedValueOnce(new Error("database unavailable"))
    expect(await analyticsAllowedForRequest(request())).toBe(false)
  })
})

describe("clearOptionalTrackingCookies", () => {
  it("expires host-only and shared-domain variants on canonical app hosts", () => {
    const response = new Response(null)
    const request = new Request("https://app.lyrashieldai.com/api/account/preferences")
    clearOptionalTrackingCookies(response, request)

    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(OPTIONAL_TRACKING_COOKIES.length * 2)
    for (const name of OPTIONAL_TRACKING_COOKIES) {
      const variants = cookies.filter((cookie) => cookie.startsWith(`${name}=`))
      expect(variants).toHaveLength(2)
      expect(variants.some((cookie) => !cookie.includes("Domain="))).toBe(true)
      expect(variants.some((cookie) => cookie.includes("Domain=.lyrashieldai.com"))).toBe(true)
      expect(variants.every((cookie) => cookie.includes("; Secure"))).toBe(true)
    }
  })

  it("never applies the parent domain on noncanonical hosts", () => {
    const response = new Response(null)
    const request = new Request("https://app.preview.lyrashieldai.com/api/account/preferences")
    clearOptionalTrackingCookies(response, request)

    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(OPTIONAL_TRACKING_COOKIES.length)
    expect(cookies.every((cookie) => !cookie.includes("Domain="))).toBe(true)
  })
})
