import { beforeEach, describe, expect, it, vi } from "vitest"

const { findUnique, getSession, upsert, withAccountRLS } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getSession: vi.fn(),
  upsert: vi.fn(),
  withAccountRLS: vi.fn(),
}))

withAccountRLS.mockImplementation((_accountId: string, callback: (tx: unknown) => unknown) =>
  callback({ accountPreference: { findUnique, upsert } })
)

vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/config", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
    NEXT_PUBLIC_MARKETING_URL: "https://lyrashieldai.com",
  },
}))
vi.mock("@lyrashield/db", () => ({ withAccountRLS }))

import { GET, PATCH } from "./route"

function patch(body: unknown, cookie = "session=present") {
  return new Request("https://app.lyrashieldai.com/api/account/preferences", {
    method: "PATCH",
    headers: {
      cookie,
      origin: "https://app.lyrashieldai.com",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

describe("/api/account/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "account-1" })
    findUnique.mockResolvedValue(null)
    upsert.mockResolvedValue({ analyticsEnabled: false })
  })

  it("returns the default enabled state without creating a row or requiring a workspace", async () => {
    const response = await GET(new Request("https://app.lyrashieldai.com/api/account/preferences"))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toMatchObject({ data: { analyticsEnabled: true } })
    expect(withAccountRLS).toHaveBeenCalledWith("account-1", expect.any(Function))
    expect(upsert).not.toHaveBeenCalled()
  })

  it("returns the account-scoped state to the configured marketing origin", async () => {
    const response = await GET(
      new Request("https://app.lyrashieldai.com/api/account/preferences", {
        headers: { origin: "https://lyrashieldai.com" },
      })
    )
    expect(response.headers.get("access-control-allow-origin")).toBe("https://lyrashieldai.com")
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("vary")).toContain("Origin")
  })

  it("rejects anonymous, API-key and OAuth sessions", async () => {
    getSession.mockResolvedValueOnce(null)
    expect(
      (await GET(new Request("https://app.lyrashieldai.com/api/account/preferences"))).status
    ).toBe(401)
    getSession.mockResolvedValueOnce({ userId: "account-1", apiKey: { keyId: "key-1" } })
    expect(
      (await GET(new Request("https://app.lyrashieldai.com/api/account/preferences"))).status
    ).toBe(403)
    const oauthSession = { userId: "account-1", oauth: { userId: "account-1" } }
    getSession.mockResolvedValueOnce(oauthSession).mockResolvedValueOnce(oauthSession)
    expect((await PATCH(patch({ analyticsEnabled: false }))).status).toBe(403)
    expect(upsert).not.toHaveBeenCalled()
  })

  it("strictly rejects account identifiers and extra mutation fields", async () => {
    const response = await PATCH(patch({ analyticsEnabled: false, accountId: "another-account" }))
    expect(response.status).toBe(400)
    expect(withAccountRLS).not.toHaveBeenCalled()
  })

  it("writes only the session account and clears optional tracking cookies when disabled", async () => {
    const response = await PATCH(patch({ analyticsEnabled: false }))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(withAccountRLS).toHaveBeenCalledWith("account-1", expect.any(Function))
    expect(upsert).toHaveBeenCalledWith({
      where: { accountId: "account-1" },
      create: { accountId: "account-1", analyticsEnabled: false },
      update: { analyticsEnabled: false },
      select: { analyticsEnabled: true },
    })
    const setCookies = response.headers.getSetCookie()
    const cookies = setCookies.join(";")
    expect(cookies).toContain("lyrashield-analytics=off")
    expect(cookies).toContain("lyrashield-acq=")
    expect(cookies).toContain("ls_ref=")
    expect(cookies).toContain("ls_ref_source=")
    expect(cookies).toContain("ls_scorecard_visitor=")
    expect(cookies).toContain("Domain=.lyrashieldai.com")
    const acquisitionCookies = setCookies.filter((cookie) => cookie.startsWith("lyrashield-acq="))
    expect(acquisitionCookies).toHaveLength(2)
    expect(acquisitionCookies.some((cookie) => !cookie.includes("Domain="))).toBe(true)
    expect(acquisitionCookies.some((cookie) => cookie.includes("Domain=.lyrashieldai.com"))).toBe(
      true
    )
  })
})
