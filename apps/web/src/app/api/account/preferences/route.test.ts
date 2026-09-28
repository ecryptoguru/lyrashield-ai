import { beforeEach, describe, expect, it, vi } from "vitest"

const { findUnique, getSession, logError, upsert, withAccountRLS } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getSession: vi.fn(),
  logError: vi.fn(),
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
vi.mock("@lyrashield/logger", () => ({ logger: { error: logError } }))

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

  it("logs only sanitized error metadata when a preference read fails", async () => {
    const error = Object.assign(
      new Error("postgres://user:password@db/secret connection timeout"),
      {
        code: "08001",
        cause: Object.assign(new Error("socket timed out for postgres://secret"), {
          code: "ETIMEDOUT",
        }),
      }
    )
    findUnique.mockRejectedValueOnce(error)

    const response = await GET(new Request("https://app.lyrashieldai.com/api/account/preferences"))

    expect(response.status).toBe(500)
    expect(logError).toHaveBeenCalledWith("Account preference read failed", {
      eventCode: "ACCOUNT_PREFERENCE_GET_FAILED",
      phase: "preference_read",
      errorClass: "Error",
      databaseCode: "08001",
      causeClassification: "connection_timeout",
      transportCode: "ETIMEDOUT",
    })
    const logged = JSON.stringify(logError.mock.calls)
    expect(logged).not.toContain("postgres://")
    expect(logged).not.toContain("password")
    expect(logged).not.toContain("account-1")
  })

  it("tags session lookup failures separately from preference reads", async () => {
    getSession.mockRejectedValueOnce(
      Object.assign(new Error("connection timeout"), { code: "ETIMEDOUT" })
    )

    const response = await GET(new Request("https://app.lyrashieldai.com/api/account/preferences"))

    expect(response.status).toBe(500)
    expect(logError).toHaveBeenCalledWith("Account preference read failed", {
      eventCode: "ACCOUNT_PREFERENCE_GET_FAILED",
      phase: "session_lookup",
      errorClass: "Error",
      databaseCode: null,
      causeClassification: "connection_timeout",
      transportCode: "ETIMEDOUT",
    })
    expect(withAccountRLS).not.toHaveBeenCalled()
  })

  it("logs sanitized metadata on failed saves while keeping the local opt-out", async () => {
    upsert.mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "08006" }))

    const response = await PATCH(patch({ analyticsEnabled: true }))

    expect(response.status).toBe(500)
    expect(logError).toHaveBeenCalledWith("Account preference update failed", {
      eventCode: "ACCOUNT_PREFERENCE_PATCH_FAILED",
      phase: "preference_write",
      errorClass: "Error",
      databaseCode: "08006",
      causeClassification: "connection_interrupted",
    })
    expect(response.headers.getSetCookie().join(";")).toContain("lyrashield-analytics=off")
    expect(JSON.stringify(logError.mock.calls)).not.toContain("connection reset")
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
