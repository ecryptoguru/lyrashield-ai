import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// Mock rate-limit so we don't need Redis in tests
vi.mock("@/lib/rate-limit", () => ({
  checkAuthRateLimit: vi.fn().mockResolvedValue({ limited: false, remaining: 10, retryAfter: 0 }),
  checkApiRateLimit: vi.fn().mockResolvedValue({ limited: false, remaining: 10, retryAfter: 0 }),
  checkBillingWebhookRateLimit: vi
    .fn()
    .mockResolvedValue({ limited: false, remaining: 1_199, retryAfter: 0 }),
  checkHealthRateLimit: vi.fn().mockReturnValue({ limited: false, remaining: 119, retryAfter: 0 }),
  checkLiteScanRateLimit: vi
    .fn()
    .mockResolvedValue({ limited: false, remaining: 10, retryAfter: 0 }),
}))

// Import after mock
const { proxy } = await import("../proxy")

describe("trusted client IP", () => {
  it("ignores forwarded headers when no trusted header is configured", async () => {
    delete process.env.TRUSTED_PROXY_IP_HEADER
    const { getClientIP } = await import("../proxy")
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.2" },
    })
    expect(getClientIP(req)).toBe("unknown")
  })

  it("uses only the configured header and its closest proxy hop", async () => {
    process.env.TRUSTED_PROXY_IP_HEADER = "x-forwarded-for"
    const { getClientIP } = await import("../proxy")
    const req = new NextRequest("http://localhost/api/test", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "198.51.100.2, 192.0.2.8",
      },
    })
    expect(getClientIP(req)).toBe("192.0.2.8")
    delete process.env.TRUSTED_PROXY_IP_HEADER
  })
})

function makeRequest(pathname: string): NextRequest {
  const url = new URL(`http://localhost:3000${pathname}`)
  return new NextRequest(url, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  })
}

function makePublicRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(`https://app.example.com${pathname}`))
}

async function cspForBrowserSentryDsn(dsn: string | undefined): Promise<string> {
  const previousDsn = process.env.NEXT_PUBLIC_SENTRY_DSN
  if (dsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN
  else process.env.NEXT_PUBLIC_SENTRY_DSN = dsn

  try {
    const response = await proxy(makeRequest("/dashboard"))
    return response.headers.get("Content-Security-Policy") ?? ""
  } finally {
    if (previousDsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN
    else process.env.NEXT_PUBLIC_SENTRY_DSN = previousDsn
  }
}

describe("CSP nonce proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sets Content-Security-Policy header on non-API routes", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")
    expect(csp).toBeTruthy()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'nonce-")
    expect(csp).toContain("'strict-dynamic'")
  })

  it("sets Content-Security-Policy header on API routes", async () => {
    const req = makeRequest("/api/projects")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")
    expect(csp).toBeTruthy()
    expect(csp).toContain("script-src 'self' 'nonce-")
  })

  it("generates a unique nonce per request", async () => {
    const req1 = makeRequest("/dashboard")
    const req2 = makeRequest("/dashboard")
    const res1 = await proxy(req1)
    const res2 = await proxy(req2)
    const csp1 = res1.headers.get("Content-Security-Policy")!
    const csp2 = res2.headers.get("Content-Security-Policy")!
    const nonce1 = csp1.match(/nonce-([^']+)'/)?.[1]
    const nonce2 = csp2.match(/nonce-([^']+)'/)?.[1]
    expect(nonce1).toBeTruthy()
    expect(nonce2).toBeTruthy()
    expect(nonce1).not.toBe(nonce2)
  })

  it("forwards x-nonce via middleware request headers", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    // Next.js forwards modified request headers as x-middleware-request-* on the response
    const forwardedNonce = res.headers.get("x-middleware-request-x-nonce")
    const csp = res.headers.get("Content-Security-Policy")!
    const cspNonce = csp.match(/nonce-([^']+)'/)?.[1]
    if (forwardedNonce) {
      expect(forwardedNonce).toBe(cspNonce)
    }
    // At minimum, the CSP must contain the nonce
    expect(cspNonce).toBeTruthy()
  })

  it("includes frame-ancestors 'none' in CSP", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("includes object-src 'none' in CSP", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("object-src 'none'")
  })

  it("includes upgrade-insecure-requests in CSP", async () => {
    const req = makePublicRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("upgrade-insecure-requests")
  })

  it("does not upgrade HTTP requests in local Docker previews", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).not.toContain("upgrade-insecure-requests")
  })

  it("allows avatar image hosts in img-src", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("avatars.githubusercontent.com")
    expect(csp).toContain("lh3.googleusercontent.com")
  })

  it("includes blob: in img-src for client-side image processing", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("blob:")
  })

  it("includes connect-src 'self' for API calls", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("https://api.razorpay.com")
  })

  it("allows the configured US PostHog ingestion and assets hosts", async () => {
    const csp = (await proxy(makeRequest("/dashboard"))).headers.get("Content-Security-Policy")!
    expect(csp).toContain("https://us-assets.i.posthog.com")
    expect(csp).toContain("connect-src 'self' https://api.razorpay.com https://us.i.posthog.com")
  })

  it("allows only the exact HTTPS origin from a valid browser Sentry DSN", async () => {
    const csp = await cspForBrowserSentryDsn("https://public-key@example.ingest.sentry.io/42")
    expect(csp).toContain("https://example.ingest.sentry.io")
    expect(csp).not.toContain("*.sentry.io")
  })

  it.each([
    "https://example.ingest.sentry.io/42",
    "http://public-key@example.ingest.sentry.io/42",
    "https://public-key:password@example.ingest.sentry.io/42",
    "https://public-key@example.ingest.sentry.io/42?next=https://other.example",
    "https://public-key@example.ingest.sentry.io/42#fragment",
    "not a DSN",
  ])("does not add a CSP origin for an invalid browser Sentry DSN", async (dsn) => {
    const csp = await cspForBrowserSentryDsn(dsn)
    expect(csp).not.toContain("example.ingest.sentry.io")
    expect(csp).not.toContain("other.example")
  })

  it("allows only Razorpay checkout frames needed by subscription management", async () => {
    const res = await proxy(makeRequest("/dashboard/billing"))
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com")
  })

  it("includes base-uri 'self' in CSP", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("base-uri 'self'")
  })

  it("includes form-action 'self' in CSP", async () => {
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("form-action 'self'")
  })

  it("sets CSP on rate-limited 429 responses", async () => {
    const { checkApiRateLimit } = await import("@/lib/rate-limit")
    vi.mocked(checkApiRateLimit).mockResolvedValueOnce({
      limited: true,
      remaining: 0,
      retryAfter: 60,
    })

    const req = makeRequest("/api/projects")
    const res = await proxy(req)
    expect(res.status).toBe(429)
    const csp = res.headers.get("Content-Security-Policy")
    expect(csp).toBeTruthy()
    expect(csp).toContain("nonce-")
    expect(res.headers.get("Retry-After")).toBe("60")
  })

  it("sets CSP on rate-limited 429 responses for auth routes", async () => {
    const { checkAuthRateLimit } = await import("@/lib/rate-limit")
    vi.mocked(checkAuthRateLimit).mockResolvedValueOnce({
      limited: true,
      remaining: 0,
      retryAfter: 30,
    })

    const req = makeRequest("/api/auth/sign-in")
    const res = await proxy(req)
    expect(res.status).toBe(429)
    const csp = res.headers.get("Content-Security-Policy")
    expect(csp).toBeTruthy()
    expect(csp).toContain("nonce-")
  })

  it("returns an OAuth-standard rate-limit error for protocol endpoints", async () => {
    const { checkAuthRateLimit } = await import("@/lib/rate-limit")
    vi.mocked(checkAuthRateLimit).mockResolvedValueOnce({
      limited: true,
      remaining: 0,
      retryAfter: 30,
    })

    const res = await proxy(makeRequest("/api/auth/oauth2/register"))

    expect(res.status).toBe(429)
    await expect(res.json()).resolves.toEqual({
      error: "temporarily_unavailable",
      error_description: "Too many requests. Please try again later.",
    })
  })

  it("does not charge session lookups against the auth mutation limit", async () => {
    const { checkApiRateLimit, checkAuthRateLimit } = await import("@/lib/rate-limit")

    const req = makeRequest("/api/auth/get-session")
    const res = await proxy(req)

    expect(res.status).toBe(200)
    expect(checkApiRateLimit).toHaveBeenCalledOnce()
    expect(checkAuthRateLimit).not.toHaveBeenCalled()
  })

  it.each(["/api/health", "/api/ready", "/api/ready/evidence", "/api/ready/scans"])(
    "does not charge the exact health path %s against Redis rate limits",
    async (pathname) => {
      const {
        checkApiRateLimit,
        checkAuthRateLimit,
        checkHealthRateLimit,
        checkLiteScanRateLimit,
      } = await import("@/lib/rate-limit")

      const response = await proxy(makeRequest(pathname))

      expect(response.status).toBe(200)
      expect(checkApiRateLimit).not.toHaveBeenCalled()
      expect(checkAuthRateLimit).not.toHaveBeenCalled()
      expect(checkLiteScanRateLimit).not.toHaveBeenCalled()
      expect(checkHealthRateLimit).toHaveBeenCalledOnce()
    }
  )

  it("keeps near-match readiness paths behind the general API limit", async () => {
    const { checkApiRateLimit } = await import("@/lib/rate-limit")

    await proxy(makeRequest("/api/ready/scans/detail"))

    expect(checkApiRateLimit).toHaveBeenCalledOnce()
  })

  it("uses a dedicated burst-safe bound for signed billing webhook ingress", async () => {
    const { checkApiRateLimit, checkBillingWebhookRateLimit } = await import("@/lib/rate-limit")
    const response = await proxy(makeRequest("/billing/webhook"))
    expect(response.status).toBe(200)
    expect(checkBillingWebhookRateLimit).toHaveBeenCalledOnce()
    expect(checkApiRateLimit).not.toHaveBeenCalled()
  })

  it("returns a bounded 429 from the billing webhook bucket", async () => {
    const { checkBillingWebhookRateLimit } = await import("@/lib/rate-limit")
    vi.mocked(checkBillingWebhookRateLimit).mockResolvedValueOnce({
      limited: true,
      remaining: 0,
      retryAfter: 60,
    })
    const response = await proxy(makeRequest("/billing/webhook"))
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
  })

  it.each([
    ["DNT", { dnt: "1" }],
    ["GPC", { "sec-gpc": "1" }],
  ])("does not capture referral attribution when %s is enabled", async (_signal, headers) => {
    const response = await proxy(
      new NextRequest("https://app.example.com/score/public?ref=CODE1234", { headers })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("Set-Cookie")).toBeNull()
  })

  it("preserves short-link navigation without tracking when GPC is enabled", async () => {
    const response = await proxy(
      new NextRequest("https://app.example.com/r/CODE1234", {
        headers: { "sec-gpc": "1" },
      })
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://app.example.com/")
    expect(response.headers.get("Set-Cookie")).toBeNull()
  })

  it("pins worker-src, media-src and manifest-src instead of relying on default-src alone", async () => {
    const res = await proxy(makeRequest("/dashboard"))
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("worker-src 'self'")
    expect(csp).toContain("media-src 'self'")
    expect(csp).toContain("manifest-src 'self'")
  })

  it("sets CSP on the affiliate subdomain rewrite", async () => {
    const response = await proxy(
      new NextRequest("https://affiliates.lyrashieldai.com/program", {
        headers: { host: "affiliates.lyrashieldai.com" },
      })
    )

    // The rewrite must not leave the proxied page without a policy — every
    // early return in the proxy carries the same headers as a page render.
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'")
  })

  it("sets HSTS on the untracked short-link redirect", async () => {
    const response = await proxy(
      new NextRequest("https://app.example.com/r/CODE1234", {
        headers: { "sec-gpc": "1" },
      })
    )
    expect(response.status).toBe(307)
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy()
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=63072000")
  })
})
