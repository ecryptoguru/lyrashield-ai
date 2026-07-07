import { describe, it, expect, vi, beforeEach } from "vitest"
import { scanUrl } from "./url-scanner"
import type { HostResolver } from "@lyrashield/security"

const mockFetch = vi.fn()

// Stub DNS resolver so tests never touch the network and always resolve target
// hosts to a safe public IP. SSRF-blocking behavior is covered explicitly below.
const stubResolver: HostResolver = async () => ["93.184.216.34"]

beforeEach(() => {
  mockFetch.mockReset()
})

function makeResponse(html: string, headers: Record<string, string> = {}, status = 200) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    ok: true,
    status,
    body: null,
    headers: {
      get: (key: string): string | null => lower[key.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [key, value] of Object.entries(headers)) {
          cb(value, key)
        }
      },
    },
    text: async () => html,
  }
}

describe("scanUrl", () => {
  it("detects Supabase anon key exposure", async () => {
    const html = `
      <script>
        const supabaseUrl = "https://abcdefgh.supabase.co";
        const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE2MDAwMDAwMDB9.signature123";
      </script>
    `
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const supabaseFinding = findings.find((f) => f.id.includes("supabase-anon-key"))
    expect(supabaseFinding).toBeDefined()
    expect(supabaseFinding!.severity).toBe("HIGH")
    expect(supabaseFinding!.cwe).toBe("CWE-200")
  })

  it("detects Firebase config exposure", async () => {
    const html = `
      <script>
        const firebaseConfig = {
          apiKey: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          authDomain: "test.firebaseapp.com",
        };
      </script>
    `
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const firebaseFinding = findings.find((f) => f.id.includes("firebase-config"))
    expect(firebaseFinding).toBeDefined()
    expect(firebaseFinding!.severity).toBe("MEDIUM")
  })

  it("detects missing security headers", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse("<html></html>", {}))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const headerFindings = findings.filter((f) => f.id.includes("missing-header"))
    expect(headerFindings.length).toBeGreaterThanOrEqual(3)
  })

  it("does not report missing headers when present", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "content-security-policy": "default-src 'self'",
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
      }),
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const headerFindings = findings.filter((f) => f.id.includes("missing-header"))
    expect(headerFindings).toHaveLength(0)
  })

  it("detects CORS wildcard with credentials", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      }),
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const corsFinding = findings.find((f) => f.id.includes("cors-wildcard-with-credentials"))
    expect(corsFinding).toBeDefined()
    expect(corsFinding!.severity).toBe("HIGH")
    expect(corsFinding!.cwe).toBe("CWE-942")
  })

  it("detects IDOR patterns", async () => {
    const html = `<script>fetch('/api/users/12345').then(r => r.json())</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const idorFinding = findings.find((f) => f.id.includes("idor-pattern"))
    expect(idorFinding).toBeDefined()
    expect(idorFinding!.cwe).toBe("CWE-639")
  })

  it("detects AI builder platform markers", async () => {
    const html = `<html><!-- Built with Lovable --></html>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const aiFinding = findings.find((f) => f.id.includes("ai-builder"))
    expect(aiFinding).toBeDefined()
    expect(aiFinding!.severity).toBe("INFO")
  })

  it("detects open redirect patterns", async () => {
    const html = `<script>window.location = redirectUrl;</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const redirectFinding = findings.find((f) => f.id.includes("open-redirect"))
    expect(redirectFinding).toBeDefined()
    expect(redirectFinding!.cwe).toBe("CWE-601")
  })

  it("detects exposed Stripe key", async () => {
    const html = `<script>const stripe = Stripe("sk_live_AbCdEf1234567890AbCdEf12")</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const stripeFinding = findings.find((f) => f.id.includes("stripe-secret-key"))
    expect(stripeFinding).toBeDefined()
    expect(stripeFinding!.severity).toBe("HIGH")
  })

  it("returns empty array when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
  })

  it("returns empty array when fetch returns null", async () => {
    mockFetch.mockResolvedValueOnce(null)
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch as unknown as typeof fetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
  })

  it("detects missing webhook signature verification", async () => {
    const html = `<script>fetch('/api/webhook/stripe', { method: 'POST', body: JSON.stringify({ event: 'payment' }) })</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const webhookFinding = findings.find((f) => f.id.includes("webhook-no-verification"))
    expect(webhookFinding).toBeDefined()
    expect(webhookFinding!.severity).toBe("HIGH")
    expect(webhookFinding!.cwe).toBe("CWE-345")
  })

  it("does not report webhook finding when signature verification is present", async () => {
    const html = `<script>const event = stripe.webhooks.constructEvent(body, stripeSignature); fetch('/api/webhook/stripe', { method: 'POST' })</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const webhookFinding = findings.find((f) => f.id.includes("webhook-no-verification"))
    expect(webhookFinding).toBeUndefined()
  })

  it("does not produce duplicate Google API key finding when Firebase config is present", async () => {
    const html = `
      <script>
        const firebaseConfig = {
          apiKey: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          authDomain: "test.firebaseapp.com",
        };
      </script>
    `
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const googleKeyFindings = findings.filter((f) => f.id.includes("google-api-key"))
    const firebaseFindings = findings.filter((f) => f.id.includes("firebase-config"))
    expect(googleKeyFindings).toHaveLength(0)
    expect(firebaseFindings).toHaveLength(1)
  })

  it("detects mixed-case headers correctly (case-insensitive)", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "Content-Security-Policy": "default-src 'self'",
        "Strict-Transport-Security": "max-age=31536000",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      }),
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const headerFindings = findings.filter((f) => f.id.includes("missing-header"))
    expect(headerFindings).toHaveLength(0)
  })

  it("blocks SSRF — skips fetch to localhost", async () => {
    const findings = await scanUrl({
      targetUrl: "http://localhost:3000",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("blocks SSRF — skips fetch to private IP range", async () => {
    const findings = await scanUrl({
      targetUrl: "http://192.168.1.1/admin",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("blocks SSRF — skips fetch to 10.x range", async () => {
    const findings = await scanUrl({
      targetUrl: "http://10.0.0.1/internal",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("blocks SSRF — skips non-HTTP protocols", async () => {
    const findings = await scanUrl({
      targetUrl: "file:///etc/passwd",
      fetchFn: mockFetch as unknown as typeof fetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("scanUrl — SSRF protection (fetch-time)", () => {
  it("blocks a target whose hostname resolves to the cloud-metadata IP (rebinding)", async () => {
    const rebindResolver: HostResolver = async () => ["169.254.169.254"]
    mockFetch.mockResolvedValue(makeResponse("<html></html>"))
    const findings = await scanUrl({
      targetUrl: "https://internal.attacker.example",
      fetchFn: mockFetch,
      resolver: rebindResolver,
    })
    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("blocks a decimal-encoded loopback address (http://2130706433 = 127.0.0.1)", async () => {
    mockFetch.mockResolvedValue(makeResponse("<html></html>"))
    const findings = await scanUrl({
      targetUrl: "http://2130706433/",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("does not follow a redirect into a private range", async () => {
    // First hop: a 302 to an internal host; safeFetch must re-validate and stop.
    mockFetch.mockResolvedValueOnce(
      makeResponse("", { location: "http://169.254.169.254/latest/meta-data/" }, 302),
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: async (host: string) =>
        host === "example.com" ? ["93.184.216.34"] : ["169.254.169.254"],
    })
    expect(findings).toHaveLength(0)
    // The redirect target must never be fetched (only the first hop).
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
