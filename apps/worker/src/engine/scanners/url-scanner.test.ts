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

function makeFixtureJwt(header: string, payload: string) {
  return [header, payload, "signature123"].join(".")
}

describe("scanUrl", () => {
  it("does not report Supabase anon keys that are public by design", async () => {
    const anonKey = makeFixtureJwt(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE2MDAwMDAwMDB9"
    )
    const html = `
      <script>
        const supabaseUrl = "https://abcdefgh.supabase.co";
        const supabaseKey = "${anonKey}";
      </script>
    `
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.includes("supabase"))).toBe(false)
  })

  it("detects Supabase service_role keys without retaining the key", async () => {
    const serviceRoleKey = makeFixtureJwt("eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0")
    const html = `
      <script>
        const supabaseUrl = "https://abcdefgh.supabase.co";
        const supabaseKey = "${serviceRoleKey}";
      </script>
    `
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const finding = findings.find((candidate) => candidate.id.includes("supabase-privileged-key"))
    expect(finding).toMatchObject({ severity: "CRITICAL", control_ids: [3] })
    expect(JSON.stringify(finding)).not.toContain("signature123")
  })

  it("does not report Firebase client configuration as a secret", async () => {
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
    expect(findings.some((finding) => finding.id.includes("firebase"))).toBe(false)
    expect(findings.some((finding) => finding.id.includes("generic-api-key"))).toBe(false)
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
    expect(headerFindings.every((finding) => finding.control_ids?.includes(27))).toBe(true)
  })

  it("does not report missing headers when present", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "content-security-policy": "default-src 'self'",
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
      })
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const headerFindings = findings.filter((f) => f.id.includes("missing-header"))
    expect(headerFindings).toHaveLength(0)
  })

  it("does not claim wildcard CORS with credentials is browser-exploitable", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      })
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.includes("cors"))).toBe(false)
  })

  it("does not claim predictable identifiers prove IDOR", async () => {
    const html = `<script>fetch('/api/users/12345').then(r => r.json())</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.includes("idor"))).toBe(false)
  })

  it("does not turn an AI-builder attribution marker into a security finding", async () => {
    const html = `<html><!-- Built with Lovable --></html>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.includes("ai-builder"))).toBe(false)
  })

  it("does not claim a dynamic redirect assignment proves an open redirect", async () => {
    const html = `<script>window.location = redirectUrl;</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.includes("open-redirect"))).toBe(false)
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
    expect(stripeFinding!.control_ids).toEqual([3])
  })

  it("detects cleartext HTTP transport", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse("<html></html>"))
    const findings = await scanUrl({
      targetUrl: "http://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.find((finding) => finding.id === "url-insecure-http")).toMatchObject({
      cwe: "CWE-319",
      control_ids: [29],
    })
  })

  it("detects cleartext HTTP when the final redirect target is HTTPS", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse("", { location: "https://example.com/final" }, 302))
      .mockResolvedValueOnce(makeResponse("<html></html>"))
    const findings = await scanUrl({
      targetUrl: "http://example.com/start",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id === "url-insecure-http")).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("detects missing protections on sensitive cookies without storing the value", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", { "set-cookie": "sessionToken=super-secret-value; Path=/" })
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    const cookieFinding = findings.find((finding) => finding.id === "url-insecure-cookie-0")
    expect(cookieFinding?.title).toContain("Secure, HttpOnly, SameSite")
    expect(cookieFinding?.control_ids).toEqual([28])
    expect(JSON.stringify(cookieFinding)).not.toContain("super-secret-value")
  })

  it("does not report a fully protected sensitive cookie", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "set-cookie": "sessionToken=value; Path=/; Secure; HttpOnly; SameSite=Lax",
      })
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.startsWith("url-insecure-cookie"))).toBe(false)
  })

  it("detects exposed stack traces", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<pre>Error: failed\n at handler (/srv/app/routes/users.js:42:7)</pre>")
    )
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.find((finding) => finding.id === "url-verbose-error")).toMatchObject({
      cwe: "CWE-209",
      control_ids: [31],
    })
  })

  it("detects production source-map references", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse('<script src="/assets/app.js.map"></script>'))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.find((finding) => finding.id === "url-source-map-exposed")).toMatchObject({
      cwe: "CWE-540",
      control_ids: [32],
    })
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

  it("does not infer missing webhook verification from a public bundle", async () => {
    const html = `<script>fetch('/api/webhook/stripe', { method: 'POST', body: JSON.stringify({ event: 'payment' }) })</script>`
    mockFetch.mockResolvedValueOnce(makeResponse(html))
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })
    expect(findings.some((finding) => finding.id.includes("webhook-no-verification"))).toBe(false)
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
    expect(findings.some((finding) => finding.id.includes("api-key"))).toBe(false)
  })

  it("detects mixed-case headers correctly (case-insensitive)", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("<html></html>", {
        "Content-Security-Policy": "default-src 'self'",
        "Strict-Transport-Security": "max-age=31536000",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      })
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

  it("blocks a hostname that resolves to a private address at fetch time", async () => {
    const findings = await scanUrl({
      targetUrl: "https://rebind.example.test",
      fetchFn: mockFetch,
      resolver: async () => ["169.254.169.254"],
    })

    expect(findings).toHaveLength(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("validates every redirect target before following it", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location" ? "http://127.0.0.1/admin" : null,
        forEach: () => undefined,
      },
      text: async () => "",
    })

    // resolver is required like every other case in this file: without it the
    // initial host resolution hits real DNS, so the scan aborts before fetching
    // and this assertion fails for an unrelated reason in offline environments.
    const findings = await scanUrl({
      targetUrl: "https://example.com",
      fetchFn: mockFetch,
      resolver: stubResolver,
    })

    expect(findings).toHaveLength(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
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
      makeResponse("", { location: "http://169.254.169.254/latest/meta-data/" }, 302)
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
