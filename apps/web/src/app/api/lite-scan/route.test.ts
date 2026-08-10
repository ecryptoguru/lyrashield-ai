import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const collectPublicSurface = vi.fn()
const checkScanUrlSafe = vi.fn()
const analyzeLiteSurface = vi.fn()

vi.mock("@lyrashield/security", () => ({ collectPublicSurface, checkScanUrlSafe, analyzeLiteSurface }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

const { POST } = await import("./route")

function request(body: unknown, origin = "http://localhost:4321") {
  return new Request("http://localhost:3001/api/lite-scan", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  })
}

describe("POST /api/lite-scan", () => {
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NODE_ENV = "test"
    process.env.NEXT_PUBLIC_MARKETING_URL = "http://localhost:4321"
    delete process.env.TURNSTILE_SECRET_KEY
    checkScanUrlSafe.mockResolvedValue({ safe: true })
    collectPublicSurface.mockResolvedValue({
      seedUrl: "https://example.com/",
      finalOrigin: "https://example.com",
      contractVersion: "url-scan/2.0.0",
      profile: expect.anything(),
      subjects: [
        {
          kind: "document",
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          urlHistory: ["https://example.com/"],
          method: "GET",
          status: 200,
          headers: {},
          body: "<html></html>",
          bodyBytes: 13,
          bodyTruncated: false,
          depth: 0,
        },
      ],
      issues: [],
      totalBytes: 13,
      truncated: false,
    })
    analyzeLiteSurface.mockReturnValue({ checks: [], liteResultSummary: { findingCount: 0 } })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true }),
      })
    )
  })

  it("requires an explicit own-or-authorized attestation", async () => {
    const response = await POST(request({ url: "https://example.com", authorized: false }))
    expect(response.status).toBe(400)
    expect(collectPublicSurface).not.toHaveBeenCalled()
  })

  it("fails closed in production when Turnstile is not configured", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.TURNSTILE_SECRET_KEY

    const response = await POST(request({ url: "https://example.com", authorized: true }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(checkScanUrlSafe).not.toHaveBeenCalled()
    expect(collectPublicSurface).not.toHaveBeenCalled()
  })

  it("requires a Turnstile token when a verification secret is configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"

    const response = await POST(request({ url: "https://example.com", authorized: true }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(checkScanUrlSafe).not.toHaveBeenCalled()
    expect(collectPublicSurface).not.toHaveBeenCalled()
  })

  it("blocks an untrusted browser origin", async () => {
    expect(
      (await POST(request({ url: "https://example.com", authorized: true }, "https://evil.test")))
        .status
    ).toBe(403)
  })

  it("fails closed when Turnstile verification returns success: false", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: false }),
      })
    )

    const response = await POST(
      request({ url: "https://example.com", authorized: true, turnstileToken: "test-token" })
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(checkScanUrlSafe).not.toHaveBeenCalled()
  })

  it("fails closed when Turnstile verification network request fails", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")))

    const response = await POST(
      request({ url: "https://example.com", authorized: true, turnstileToken: "test-token" })
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(checkScanUrlSafe).not.toHaveBeenCalled()
  })

  it("retries Turnstile verification on transient network failure then succeeds", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true }),
      })
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      request({ url: "https://example.com", authorized: true, turnstileToken: "test-token" })
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry a definitive Turnstile failure (success: false)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: false }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await POST(
      request({ url: "https://example.com", authorized: true, turnstileToken: "test-token" })
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects private or reserved targets before fetching", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"
    checkScanUrlSafe.mockResolvedValue({ safe: false, reason: "blocked_ip" })
    const response = await POST(
      request({ url: "http://169.254.169.254", authorized: true, turnstileToken: "test-token" })
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "ssrf_blocked" })
    expect(collectPublicSurface).not.toHaveBeenCalled()
  })

  it("uses the shared public-surface collector and scans only linked same-origin assets", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"
    collectPublicSurface.mockResolvedValue({
      seedUrl: "https://example.com/",
      finalOrigin: "https://example.com",
      contractVersion: "url-scan/2.0.0",
      profile: expect.anything(),
      subjects: [
        {
          kind: "document",
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          urlHistory: ["https://example.com/"],
          method: "GET",
          status: 200,
          headers: { "content-type": "text/html" },
          body: '<script src="/assets/app.js"></script><script src="https://cdn.evil.test/x.js"></script>',
          bodyBytes: 98,
          bodyTruncated: false,
          depth: 0,
        },
        {
          kind: "asset",
          requestedUrl: "https://example.com/assets/app.js",
          finalUrl: "https://example.com/assets/app.js",
          urlHistory: [],
          method: "GET",
          status: 200,
          headers: {},
          body: "public bundle",
          bodyBytes: 13,
          bodyTruncated: false,
          depth: 1,
        },
      ],
      issues: [],
      totalBytes: 111,
      truncated: false,
    })

    const response = await POST(
      request({
        url: "https://example.com",
        authorized: true,
        turnstileToken: "test-token",
      })
    )
    expect(response.status).toBe(200)
    expect(collectPublicSurface).toHaveBeenCalledTimes(1)
    expect(collectPublicSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        seedUrl: "https://example.com",
        userAgent: expect.stringContaining("LyraShield-Lite"),
      })
    )
    expect(analyzeLiteSurface).toHaveBeenCalledWith(
      expect.objectContaining({ publicAssetText: "public bundle" })
    )
  })
})
