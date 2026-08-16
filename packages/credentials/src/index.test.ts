import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

const readFile = vi.hoisted(() => vi.fn())
vi.mock("node:fs/promises", () => ({ readFile }))

import {
  CREDENTIALS_FILE,
  DEFAULT_API_URL,
  normalizeCredentials,
  readCredentialsFile,
  refreshOAuthCredentials,
  revokeOAuthCredentials,
  tryReadCredentialsFile,
  resolveCredentials,
} from "./index.js"

function enoent() {
  return Object.assign(new Error("not found"), { code: "ENOENT" })
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  readFile.mockReset()
  delete process.env.LYRASHIELD_API_KEY
  delete process.env.LYRASHIELD_API_URL
  delete process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("normalizeCredentials", () => {
  it("drops unknown keys and trims values", () => {
    const result = normalizeCredentials({
      apiKey: "  key  ",
      apiUrl: " https://example.test ",
      workspaceId: " ws ",
      installId: "install-1",
      // @ts-expect-error deliberately passing a stale field a hand-edited file could carry
      stale: "should not survive",
    })

    expect(result).toEqual({
      apiKey: "key",
      apiUrl: "https://example.test",
      workspaceId: "ws",
      installId: "install-1",
    })
    expect("stale" in result).toBe(false)
  })

  it("mints an installId when absent and drops whitespace-only values", () => {
    const result = normalizeCredentials({ apiKey: "   ", installId: "" })
    expect(result.installId).toMatch(/[0-9a-f-]{36}/)
    expect(result.apiKey).toBeUndefined()
  })
})

describe("readCredentialsFile", () => {
  it("returns undefined when the file does not exist", async () => {
    readFile.mockRejectedValueOnce(enoent())
    await expect(readCredentialsFile()).resolves.toBeUndefined()
  })

  it("throws an actionable error on malformed JSON without leaking the raw error", async () => {
    readFile.mockResolvedValueOnce("{ not json")
    await expect(readCredentialsFile()).rejects.toThrow(
      `${CREDENTIALS_FILE} is not valid JSON. Delete it and run: lyrashield login`
    )
  })

  it("throws an actionable error when the file is unreadable", async () => {
    readFile.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    await expect(readCredentialsFile()).rejects.toThrow(/Check the file's permissions/)
  })
})

describe("tryReadCredentialsFile", () => {
  it("swallows a corrupt file so env vars can still win", async () => {
    readFile.mockResolvedValueOnce("{ not json")
    await expect(tryReadCredentialsFile()).resolves.toBeUndefined()
  })
})

describe("DEFAULT_API_URL", () => {
  it("pins the default to the production app origin", () => {
    // This is the single source of truth for the app API base URL; the CLI,
    // MCP server, and SDK fallbacks must all agree with it. Pin the literal so
    // an accidental change here is a deliberate, reviewed edit.
    expect(DEFAULT_API_URL).toBe("https://app.lyrashieldai.com")
  })
})

describe("resolveCredentials", () => {
  it("prefers environment variables over the stored file", async () => {
    process.env.LYRASHIELD_API_KEY = "env-key"
    readFile.mockResolvedValueOnce(
      JSON.stringify({ apiKey: "file-key", apiUrl: "https://file.test", installId: "i" })
    )

    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBe("env-key")
    // apiUrl has no env override here, so the file value still applies.
    expect(resolved.apiUrl).toBe("https://file.test")
    expect(resolved.source).toBe("env")
  })

  it("falls back to the file, then to the default API URL", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ apiKey: "file-key", installId: "i" }))

    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBe("file-key")
    expect(resolved.apiUrl).toBe(DEFAULT_API_URL)
    expect(resolved.source).toBe("file")
  })

  it("accepts an OAuth bearer as the interactive credential fallback", async () => {
    process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN = "oauth-token"
    readFile.mockRejectedValueOnce(enoent())
    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBe("oauth-token")
    expect(resolved.source).toBe("env")
  })

  it("keeps an environment OAuth bearer classified as OAuth when an old API key remains on disk", async () => {
    process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN = "oauth-token"
    readFile.mockResolvedValueOnce(JSON.stringify({ apiKey: "old-api-key", installId: "i" }))

    const resolved = await resolveCredentials()

    expect(resolved.apiKey).toBe("oauth-token")
    expect(resolved.credentialKind).toBe("oauth")
  })

  it("reports source none when nothing is configured", async () => {
    readFile.mockRejectedValueOnce(enoent())

    const resolved = await resolveCredentials()
    expect(resolved.apiKey).toBeUndefined()
    expect(resolved.apiUrl).toBe(DEFAULT_API_URL)
    expect(resolved.source).toBe("none")
  })

  it("propagates a corrupt-file error by default but tolerates it when asked", async () => {
    readFile.mockResolvedValue("{ not json")

    await expect(resolveCredentials()).rejects.toThrow(/not valid JSON/)

    process.env.LYRASHIELD_API_KEY = "env-key"
    const tolerant = await resolveCredentials({ tolerateUnreadableFile: true })
    expect(tolerant.apiKey).toBe("env-key")
  })
})

describe("refreshOAuthCredentials", () => {
  it("refreshes an expired stored OAuth access token and keeps the rotated refresh token", async () => {
    const refreshedPayload = { access: "fresh-access-token", refresh: "fresh-refresh-token" }
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: refreshedPayload.access,
            refresh_token: refreshedPayload.refresh,
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ) as unknown as typeof fetch

    const refreshed = await refreshOAuthCredentials(
      {
        installId: "install-1",
        apiUrl: "https://app.example.com",
        oauthAccessToken: "expired-access-token",
        oauthRefreshToken: "old-refresh-token",
        oauthExpiresAt: "2020-01-01T00:00:00.000Z",
      },
      { fetchFn, now: () => Date.parse("2026-08-12T00:00:00.000Z") }
    )

    expect(fetchFn).toHaveBeenCalledWith(
      "https://app.example.com/api/auth/oauth2/token",
      expect.objectContaining({ method: "POST" })
    )
    expect(refreshed).toMatchObject({
      oauthAccessToken: "fresh-access-token",
      oauthRefreshToken: "fresh-refresh-token",
    })
    expect(Date.parse(refreshed.oauthExpiresAt ?? "")).toBeGreaterThan(
      Date.parse("2026-08-12T00:59:00.000Z")
    )
  })
})

describe("revokeOAuthCredentials", () => {
  it("revokes the stored refresh token before local logout removes it", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 200 })
    ) as unknown as typeof fetch

    await revokeOAuthCredentials(
      {
        installId: "install-1",
        apiUrl: "https://app.example.com",
        oauthRefreshToken: "refresh-token",
      },
      { fetchFn }
    )

    expect(fetchFn).toHaveBeenCalledWith(
      "https://app.example.com/api/auth/oauth2/revoke",
      expect.objectContaining({ method: "POST" })
    )
  })
})
