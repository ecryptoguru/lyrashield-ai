/* eslint-disable security/detect-non-literal-fs-filename */
import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest"
import { mkdir, writeFile, unlink, rm } from "node:fs/promises"
import path from "node:path"
import { resolveMcpCredentials, NoApiKeyError, CREDENTIALS_FILE } from "./credentials"

// Keep tests isolated from the real home directory by redirecting homedir()
// to a per-file temp directory that is removed after the suite.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os")
  const { mkdtemp } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  const { join } = await import("node:path")
  const tempHome = await mkdtemp(join(actual.tmpdir(), "mcp-creds-"))
  process.env.MCP_TEST_HOME = tempHome
  return { ...actual, homedir: () => tempHome }
})

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.LYRASHIELD_API_KEY
  delete process.env.LYRASHIELD_API_URL
})

afterEach(async () => {
  process.env = ORIGINAL_ENV
  vi.unstubAllGlobals()
  try {
    await unlink(CREDENTIALS_FILE)
  } catch {
    // ignore missing file
  }
})

afterAll(async () => {
  if (process.env.MCP_TEST_HOME) {
    await rm(process.env.MCP_TEST_HOME, { recursive: true, force: true })
  }
})

describe("resolveMcpCredentials", () => {
  it("prefers env vars over the credentials file", async () => {
    process.env.LYRASHIELD_API_KEY = "lsk_env"
    process.env.LYRASHIELD_API_URL = "https://env.example.com"
    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true })
    await writeFile(
      CREDENTIALS_FILE,
      JSON.stringify({ apiKey: "lsk_file", apiUrl: "https://file.example.com" })
    )

    const creds = await resolveMcpCredentials()

    expect(creds.apiKey).toBe("lsk_env")
    expect(creds.apiUrl).toBe("https://env.example.com")
  })

  it("falls back to the credentials file when env vars are absent", async () => {
    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true })
    await writeFile(
      CREDENTIALS_FILE,
      JSON.stringify({ apiKey: "lsk_file", apiUrl: "https://file.example.com" })
    )

    const creds = await resolveMcpCredentials()

    expect(creds.apiKey).toBe("lsk_file")
    expect(creds.apiUrl).toBe("https://file.example.com")
  })

  it("uses the default URL when the credentials file omits one", async () => {
    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true })
    await writeFile(CREDENTIALS_FILE, JSON.stringify({ apiKey: "lsk_file" }))

    const creds = await resolveMcpCredentials()

    expect(creds.apiKey).toBe("lsk_file")
    expect(creds.apiUrl).toBe("https://app.lyrashieldai.com")
  })

  it("refreshes an expired stored OAuth credential before starting the MCP server", async () => {
    const refreshed = { access: "fresh-oauth-access-token", refresh: "fresh-oauth-refresh-token" }
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: refreshed.access,
            refresh_token: refreshed.refresh,
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    )
    vi.stubGlobal("fetch", fetchFn)
    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true })
    await writeFile(
      CREDENTIALS_FILE,
      JSON.stringify({
        installId: "install-1",
        apiUrl: "https://app.example.com",
        oauthAccessToken: "expired-oauth-access-token",
        oauthRefreshToken: "old-oauth-refresh-token",
        oauthExpiresAt: "2020-01-01T00:00:00.000Z",
      })
    )

    const creds = await resolveMcpCredentials()

    expect(creds.apiKey).toBe("fresh-oauth-access-token")
    expect(fetchFn).toHaveBeenCalledWith(
      "https://app.example.com/api/auth/oauth2/token",
      expect.objectContaining({ method: "POST" })
    )
  })

  it("throws NoApiKeyError when no key is available", async () => {
    await expect(resolveMcpCredentials()).rejects.toBeInstanceOf(NoApiKeyError)
  })
})
