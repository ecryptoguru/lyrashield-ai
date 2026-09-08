/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const testHome = vi.hoisted(() => ({ dir: "" }))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testHome.dir,
}))

import {
  CREDENTIALS_FILE,
  CREDENTIALS_DIR,
  CREDENTIALS_LOCK_FILE,
  DEFAULT_API_URL,
  StoredCredentials,
  readCredentialsFile,
  writeCredentialsFile,
  refreshOAuthCredentials,
  resolveCredentials,
  withCredentialsLock,
  hasCredentialsChanged,
  hasUsableOAuthAccessToken,
  OAuthRefreshError,
} from "./index.js"

const ORIGINAL_ENV = { ...process.env }

beforeAll(async () => {
  testHome.dir = await mkdtemp(path.join(tmpdir(), "lyrashield-cred-lifecycle-"))
})

afterAll(async () => {
  await rm(testHome.dir, { recursive: true, force: true })
})

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.LYRASHIELD_API_KEY
  delete process.env.LYRASHIELD_API_URL
  delete process.env.LYRASHIELD_OAUTH_ACCESS_TOKEN
  await mkdir(CREDENTIALS_DIR, { recursive: true })
})

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  await rm(CREDENTIALS_DIR, { recursive: true, force: true }).catch(() => {})
})

describe("WP-01 Credential Lifecycle and Refresh Regressions", () => {
  it("detects when only refresh token or expiry changed even if access token is unchanged", () => {
    const original: StoredCredentials = {
      installId: "inst-1",
      apiKey: undefined,
      oauthAccessToken: "same-access-token",
      oauthRefreshToken: "old-refresh-token",
      oauthExpiresAt: "2026-09-08T12:00:00.000Z",
      apiUrl: DEFAULT_API_URL,
    }

    const rotatedRefreshToken: StoredCredentials = {
      ...original,
      oauthRefreshToken: "new-rotated-refresh-token",
    }

    const updatedExpiryOnly: StoredCredentials = {
      ...original,
      oauthExpiresAt: "2026-09-08T13:00:00.000Z",
    }

    expect(hasCredentialsChanged(original, rotatedRefreshToken)).toBe(true)
    expect(hasCredentialsChanged(original, updatedExpiryOnly)).toBe(true)
    expect(hasCredentialsChanged(original, { ...original })).toBe(false)
  })

  it("handles refresh-only response preserving existing access token if provider returns same access token", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ["access_token"]: "same-access-token",
            ["refresh_token"]: "next-refresh-token",
            expires_in: 7200,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ) as unknown as typeof fetch

    const initial: StoredCredentials = {
      installId: "inst-1",
      apiUrl: DEFAULT_API_URL,
      oauthAccessToken: "same-access-token",
      oauthRefreshToken: "prev-refresh-token",
      oauthExpiresAt: "2020-01-01T00:00:00.000Z",
    }

    const refreshed = await refreshOAuthCredentials(initial, {
      fetchFn,
      now: () => Date.parse("2026-09-08T12:00:00.000Z"),
    })

    expect(refreshed.oauthAccessToken).toBe("same-access-token")
    expect(refreshed.oauthRefreshToken).toBe("next-refresh-token")
    expect(hasCredentialsChanged(initial, refreshed)).toBe(true)
  })

  it("distinguishes transient errors (429, 503) from permanent invalid_grant", async () => {
    const fetchTransient = vi.fn(
      async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 })
    ) as unknown as typeof fetch

    const initial: StoredCredentials = {
      installId: "inst-1",
      apiUrl: DEFAULT_API_URL,
      oauthAccessToken: "current-access-token",
      oauthRefreshToken: "valid-refresh-token",
      oauthExpiresAt: "2020-01-01T00:00:00.000Z",
    }

    await expect(
      refreshOAuthCredentials(initial, { fetchFn: fetchTransient, retries: 0 })
    ).rejects.toThrow(OAuthRefreshError)

    try {
      await refreshOAuthCredentials(initial, { fetchFn: fetchTransient, retries: 0 })
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthRefreshError)
      expect((err as OAuthRefreshError).isTransient).toBe(true)
    }

    const fetchPermanent = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
    ) as unknown as typeof fetch

    try {
      await refreshOAuthCredentials(initial, { fetchFn: fetchPermanent, retries: 0 })
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthRefreshError)
      expect((err as OAuthRefreshError).permanent).toBe(true)
    }
  })

  it("treats missing oauthExpiresAt as unknown expiry and triggers refresh when refresh token is present", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ["access_token"]: "new-access-token",
            ["refresh_token"]: "new-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ) as unknown as typeof fetch

    const initialWithoutExpiry: StoredCredentials = {
      installId: "inst-1",
      apiUrl: DEFAULT_API_URL,
      oauthAccessToken: "token-without-expiry",
      oauthRefreshToken: "refresh-token",
    }

    const refreshed = await refreshOAuthCredentials(initialWithoutExpiry, {
      fetchFn,
      now: () => Date.parse("2026-09-08T12:00:00.000Z"),
    })

    expect(fetchFn).toHaveBeenCalled()
    expect(refreshed.oauthAccessToken).toBe("new-access-token")
  })

  it("distinguishes a usable fallback token from an expired token", () => {
    expect(hasUsableOAuthAccessToken({ oauthAccessToken: "token" })).toBe(true)
    expect(
      hasUsableOAuthAccessToken(
        { oauthAccessToken: "token", oauthExpiresAt: "2026-09-08T11:59:00.000Z" },
        Date.parse("2026-09-08T12:00:00.000Z")
      )
    ).toBe(false)
  })

  it("uses an issuer path without duplicating the auth prefix", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ["access_token"]: "next", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch

    await refreshOAuthCredentials(
      {
        installId: "inst-issuer",
        issuer: "https://app.example.com/api/auth",
        resource: "https://app.example.com/api/mcp",
        oauthRefreshToken: "refresh",
      },
      { fetchFn, retries: 0 }
    )

    expect(fetchFn).toHaveBeenCalledWith(
      "https://app.example.com/api/auth/oauth2/token",
      expect.objectContaining({
        body: expect.stringContaining("resource=https%3A%2F%2Fapp.example.com%2Fapi%2Fmcp"),
      })
    )
  })

  it("rejects accidental transmission of stored credentials to an unrelated origin selected by an override", async () => {
    await writeCredentialsFile({
      installId: "i-origin",
      apiKey: "prod-secret-key",
      apiUrl: "https://app.lyrashieldai.com",
    })

    process.env.LYRASHIELD_API_URL = "https://unrelated-attacker.com"
    const resolved = await resolveCredentials()

    expect(resolved.apiKey).toBeUndefined()
    expect(resolved.credentialKind).toBe("none")
    expect(resolved.originMismatch).toBe(true)
    expect(resolved.source).toBe("none")
  })

  it("allows environment credentials to take precedence over mismatched stored credentials", async () => {
    await writeCredentialsFile({
      installId: "i-origin",
      apiKey: "stored-key",
      apiUrl: "https://app.lyrashieldai.com",
    })

    process.env.LYRASHIELD_API_KEY = "env-override-key"
    process.env.LYRASHIELD_API_URL = "https://custom.lyrashieldai.com"
    const resolved = await resolveCredentials()

    expect(resolved.apiKey).toBe("env-override-key")
    expect(resolved.source).toBe("env")
    expect(resolved.apiUrl).toBe("https://custom.lyrashieldai.com")
  })

  it("coordinates parallel readers and writers under withCredentialsLock", async () => {
    let active = 0
    let maxConcurrent = 0

    const tasks = Array.from({ length: 10 }, (_, index) =>
      withCredentialsLock(async () => {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return index
      })
    )

    const results = await Promise.all(tasks)
    expect(results).toHaveLength(10)
    expect(maxConcurrent).toBe(1)
  })

  it("recovers safely from a stale lock left by a dead process", async () => {
    await mkdir(CREDENTIALS_DIR, { recursive: true })
    // Write an expired/stale lock file
    await writeFile(
      CREDENTIALS_LOCK_FILE,
      JSON.stringify({ pid: 99999999, createdAt: Date.now() - 20000 })
    )

    const result = await withCredentialsLock(async () => "recovered", { staleMs: 1000 })
    expect(result).toBe("recovered")
  })

  it("does not steal a fresh lock while its owner is still writing metadata", async () => {
    await mkdir(CREDENTIALS_DIR, { recursive: true })
    await writeFile(CREDENTIALS_LOCK_FILE, "")

    await expect(
      withCredentialsLock(async () => "must-not-run", { timeoutMs: 20, staleMs: 1000 })
    ).rejects.toThrow("Timed out waiting for credentials lock")
    expect(await readFile(CREDENTIALS_LOCK_FILE, "utf-8")).toBe("")
  })

  it("prevents an in-flight refresh from resurrecting a logged-out credential profile", async () => {
    await writeCredentialsFile({
      installId: "inst-race",
      oauthAccessToken: "old-access",
      oauthRefreshToken: "race-refresh-token",
      apiUrl: DEFAULT_API_URL,
    })

    const stored = (await readCredentialsFile())!
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ["access_token"]: "late-refreshed-token",
            ["refresh_token"]: "late-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    ) as unknown as typeof fetch

    const refreshedPromise = refreshOAuthCredentials(stored, { fetchFn })

    // Logout happens while refresh is in flight
    await rm(CREDENTIALS_FILE, { force: true })

    const refreshed = await refreshedPromise

    // When saving, the lock check must see that credentials file was deleted / refresh token changed
    await withCredentialsLock(async () => {
      const current = await readCredentialsFile()
      if (current && current.oauthRefreshToken === stored.oauthRefreshToken) {
        await writeCredentialsFile(refreshed)
      }
    })

    // Assert that credentials were NOT resurrected
    const finalStored = await readCredentialsFile()
    expect(finalStored).toBeUndefined()
  })
})
