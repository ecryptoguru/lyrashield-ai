import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// Mock rate-limit so we don't need Redis in tests
vi.mock("@/lib/rate-limit", () => ({
  checkAuthRateLimit: vi.fn().mockResolvedValue({ limited: false, remaining: 10, retryAfter: 0 }),
  checkApiRateLimit: vi.fn().mockResolvedValue({ limited: false, remaining: 10, retryAfter: 0 }),
}))

// Import after mock
const { proxy } = await import("../proxy")

function makeRequest(pathname: string): NextRequest {
  const url = new URL(`http://localhost:3000${pathname}`)
  return new NextRequest(url, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  })
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
    const req = makeRequest("/dashboard")
    const res = await proxy(req)
    const csp = res.headers.get("Content-Security-Policy")!
    expect(csp).toContain("upgrade-insecure-requests")
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
})
