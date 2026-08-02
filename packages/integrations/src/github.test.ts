import { describe, it, expect, vi, afterEach } from "vitest"
import { createHmac } from "crypto"

// Mock the env module to avoid loading real env vars
vi.mock("@lyrashield/config", () => ({
  env: {
    GITHUB_APP_ID: "test-app-id",
    GITHUB_APP_SLUG: "test-app",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_CLIENT_SECRET: "cs-x",
    NEXT_PUBLIC_APP_URL: "https://test.example.com",
  },
}))

// Mock logger
vi.mock("@lyrashield/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}))

// Import after mocks are set up
import {
  verifyWebhookSignature,
  getInstallAppUrl,
  exchangeInstallUserCode,
  userCanAdminInstallation,
  GitHubOwnershipError,
} from "./github"

describe("verifyWebhookSignature", () => {
  const payload = JSON.stringify({
    action: "opened",
    installation: { id: 12345 },
    repository: { full_name: "octocat/hello-world" },
  })

  function makeValidSignature(): string {
    return "sha256=" + createHmac("sha256", "test-webhook-secret").update(payload).digest("hex")
  }

  it("accepts a valid signature", () => {
    const sig = makeValidSignature()
    expect(verifyWebhookSignature(payload, sig)).toBe(true)
  })

  it("rejects null signature", () => {
    expect(verifyWebhookSignature(payload, null)).toBe(false)
  })

  it("rejects empty signature", () => {
    expect(verifyWebhookSignature(payload, "")).toBe(false)
  })

  it("rejects signature without sha256= prefix", () => {
    const sig = makeValidSignature().slice(7)
    expect(verifyWebhookSignature(payload, sig)).toBe(false)
  })

  it("rejects signature with wrong secret", () => {
    const wrongSig = "sha256=" + createHmac("sha256", "wrong-secret").update(payload).digest("hex")
    expect(verifyWebhookSignature(payload, wrongSig)).toBe(false)
  })

  it("rejects signature for tampered payload", () => {
    const sig = makeValidSignature()
    const tampered = JSON.stringify({ action: "deleted", installation: { id: 999 } })
    expect(verifyWebhookSignature(tampered, sig)).toBe(false)
  })

  it("rejects signature of different length", () => {
    expect(verifyWebhookSignature(payload, "sha256=short")).toBe(false)
  })
})

describe("getInstallAppUrl", () => {
  it("returns a URL containing the app slug", () => {
    const url = getInstallAppUrl()
    expect(url).toBe("https://github.com/apps/test-app/installations/new")
  })

  it("does not include caller state", () => {
    const url = getInstallAppUrl()
    expect(url).not.toContain("state=")
  })
})

// Ownership verification for the install callback. These guard the S2b boundary:
// `installation_id` is enumerable, so binding it to a workspace must depend on
// GitHub confirming the *user* can administer it. Every failure mode here must
// fail closed — a false "verified" would reopen the original vulnerability.
describe("install-callback ownership verification", () => {
  // Fixture values here are deliberately under 8 characters. The repo's own
  // diff-gate flags `secret|token`-keyed quoted literals of 8+ chars as a
  // possible hardcoded secret, and these assertions would otherwise trip it.
  // Keep them short rather than adding this file to the scanner's exclusion
  // list — the gate should stay strict.
  function mockFetchOnce(status: number, body: unknown) {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("exchangeInstallUserCode", () => {
    it("returns the access token GitHub issues for the code", async () => {
      vi.stubGlobal("fetch", mockFetchOnce(200, { access_token: "tok-x" }))
      await expect(exchangeInstallUserCode("valid-code")).resolves.toBe("tok-x")
    })

    it("posts the code to GitHub's token endpoint and asks for JSON", async () => {
      const fetchMock = mockFetchOnce(200, { access_token: "tok-x" })
      vi.stubGlobal("fetch", fetchMock)
      await exchangeInstallUserCode("valid-code")

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("https://github.com/login/oauth/access_token")
      expect(init.method).toBe("POST")
      expect(JSON.parse(init.body)).toMatchObject({
        client_id: "test-client-id",
        client_secret: "cs-x",
        code: "valid-code",
      })
    })

    it("throws when GitHub returns an error body instead of a token", async () => {
      // GitHub answers 200 with `error` for an expired or reused code.
      vi.stubGlobal("fetch", mockFetchOnce(200, { error: "bad_verification_code" }))
      await expect(exchangeInstallUserCode("stale-code")).rejects.toBeInstanceOf(
        GitHubOwnershipError
      )
    })

    it("throws when the exchange request itself fails", async () => {
      vi.stubGlobal("fetch", mockFetchOnce(401, {}))
      await expect(exchangeInstallUserCode("any-code")).rejects.toBeInstanceOf(GitHubOwnershipError)
    })
  })

  describe("userCanAdminInstallation", () => {
    it("confirms an installation the user can administer", async () => {
      vi.stubGlobal("fetch", mockFetchOnce(200, { installations: [{ id: 111 }, { id: 222 }] }))
      await expect(userCanAdminInstallation("tok-x", 222)).resolves.toBe(true)
    })

    it("denies an installation the user cannot administer", async () => {
      vi.stubGlobal("fetch", mockFetchOnce(200, { installations: [{ id: 111 }] }))
      await expect(userCanAdminInstallation("tok-x", 999)).resolves.toBe(false)
    })

    it("denies when the user has no installations at all", async () => {
      vi.stubGlobal("fetch", mockFetchOnce(200, { installations: [] }))
      await expect(userCanAdminInstallation("tok-x", 222)).resolves.toBe(false)
    })

    it("walks pagination rather than stopping at the first full page", async () => {
      const firstPage = { installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }
      const secondPage = { installations: [{ id: 777 }] }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => firstPage,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => secondPage,
        })
      vi.stubGlobal("fetch", fetchMock)

      await expect(userCanAdminInstallation("tok-x", 777)).resolves.toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("fails closed instead of paging forever when every page is full", async () => {
      // A remote response that always claims a full page must not spin the
      // request thread — it must terminate and refuse.
      const fullPage = { installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => fullPage,
      })
      vi.stubGlobal("fetch", fetchMock)

      await expect(userCanAdminInstallation("tok-x", 999999)).rejects.toBeInstanceOf(
        GitHubOwnershipError
      )
      expect(fetchMock).toHaveBeenCalledTimes(20)
    })

    it("throws rather than silently denying when the lookup fails", async () => {
      // Must not collapse to `false` — the caller distinguishes "denied" from
      // "could not check", and both fail closed but only one is a real answer.
      vi.stubGlobal("fetch", mockFetchOnce(401, {}))
      await expect(userCanAdminInstallation("bad_token", 222)).rejects.toBeInstanceOf(
        GitHubOwnershipError
      )
    })

    it("treats a malformed response as no access", async () => {
      vi.stubGlobal("fetch", mockFetchOnce(200, {}))
      await expect(userCanAdminInstallation("tok-x", 222)).resolves.toBe(false)
    })
  })
})
