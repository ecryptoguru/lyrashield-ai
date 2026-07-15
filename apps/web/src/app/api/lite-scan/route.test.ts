import { beforeEach, describe, expect, it, vi } from "vitest"

const safeFetch = vi.fn()
const checkScanUrlSafe = vi.fn()
const analyzeLiteSurface = vi.fn()

vi.mock("@lyrashield/security", () => ({ safeFetch, checkScanUrlSafe, analyzeLiteSurface }))
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
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NODE_ENV = "test"
    process.env.NEXT_PUBLIC_MARKETING_URL = "http://localhost:4321"
    delete process.env.TURNSTILE_SECRET_KEY
    checkScanUrlSafe.mockResolvedValue({ safe: true })
    safeFetch.mockResolvedValue({
      html: "<html></html>",
      status: 200,
      headers: {},
      finalUrl: "https://example.com/",
      urlHistory: ["https://example.com/"],
    })
    analyzeLiteSurface.mockReturnValue({ checks: [], liteResultSummary: { findingCount: 0 } })
  })

  it("requires an explicit own-or-authorized attestation", async () => {
    const response = await POST(request({ url: "https://example.com", authorized: false }))
    expect(response.status).toBe(400)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it("fails closed in production when Turnstile is not configured", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.TURNSTILE_SECRET_KEY

    const response = await POST(request({ url: "https://example.com", authorized: true }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(checkScanUrlSafe).not.toHaveBeenCalled()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it("requires a Turnstile token when a verification secret is configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret"

    const response = await POST(request({ url: "https://example.com", authorized: true }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "bot_check_failed" })
    expect(checkScanUrlSafe).not.toHaveBeenCalled()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it("blocks an untrusted browser origin", async () => {
    expect(
      (await POST(request({ url: "https://example.com", authorized: true }, "https://evil.test")))
        .status
    ).toBe(403)
  })

  it("rejects private or reserved targets before fetching", async () => {
    checkScanUrlSafe.mockResolvedValue({ safe: false, reason: "blocked_ip" })
    const response = await POST(request({ url: "http://169.254.169.254", authorized: true }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "ssrf_blocked" })
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it("uses the pinned passive fetch limits and scans only linked same-origin assets", async () => {
    safeFetch
      .mockResolvedValueOnce({
        html: '<script src="/assets/app.js"></script><script src="https://cdn.evil.test/x.js"></script>',
        status: 200,
        headers: { "content-type": "text/html" },
        finalUrl: "https://example.com/",
        urlHistory: ["https://example.com/"],
      })
      .mockResolvedValueOnce({
        html: "public bundle",
        status: 200,
        headers: {},
        finalUrl: "https://example.com/assets/app.js",
        urlHistory: [],
      })

    const response = await POST(request({ url: "https://example.com", authorized: true }))
    expect(response.status).toBe(200)
    expect(safeFetch).toHaveBeenCalledTimes(2)
    expect(safeFetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com",
      expect.objectContaining({ timeoutMs: 10_000, maxRedirects: 3, maxBytes: 4 * 1024 * 1024 })
    )
    expect(safeFetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/assets/app.js",
      expect.objectContaining({ timeoutMs: 10_000, maxRedirects: 3, maxBytes: 750 * 1024 })
    )
    expect(analyzeLiteSurface).toHaveBeenCalledWith(
      expect.objectContaining({ publicAssetText: "public bundle" })
    )
  })
})
