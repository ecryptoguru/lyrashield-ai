import { describe, expect, it } from "vitest"
import {
  analyzePublicSurface,
  isDetectedSignal,
  type SurfaceSignal,
} from "./public-surface-analysis"
import type { SurfaceCollection } from "./public-surface"
import { URL_SCAN_CONTRACT_VERSION } from "@lyrashield/types"

const baselineHeaders = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=()",
} as const

const safeProfile = {
  id: "WEB_APP_SAFE",
  targetType: "WEB_APP",
  mode: "SAFE",
  label: "Surface Review",
  description: "Safe",
  maxDocuments: 1,
  maxAssets: 6,
  maxDepth: 0,
  maxTotalBytes: 8 * 1024 * 1024,
  maxResponseBytes: 3 * 1024 * 1024,
  maxConcurrency: 3,
  maxWallTimeMs: 60_000,
  maxOperations: 0,
  maxMethodProbes: 0,
  maxOriginProbes: 0,
  allowedMethods: ["GET"],
  requiresApiSpec: false,
} as const

function makeCollection(overrides: {
  seedUrl?: string
  finalOrigin?: string
  subjects?: Partial<SurfaceCollection>["subjects"]
  headers?: Record<string, string>
  body?: string
}): SurfaceCollection {
  const seedUrl = overrides.seedUrl ?? "https://example.test/"
  const body = overrides.body ?? "<html></html>"
  return {
    seedUrl,
    finalOrigin: overrides.finalOrigin ?? "https://example.test",
    contractVersion: URL_SCAN_CONTRACT_VERSION,
    profile: safeProfile,
    subjects: (overrides.subjects as SurfaceCollection["subjects"]) ?? [
      {
        kind: "document",
        requestedUrl: seedUrl,
        finalUrl: seedUrl,
        urlHistory: [seedUrl],
        method: "GET",
        status: 200,
        headers: overrides.headers ?? {},
        body,
        bodyBytes: Buffer.byteLength(body, "utf8"),
        bodyTruncated: false,
        depth: 0,
      },
    ],
    issues: [],
    totalBytes: Buffer.byteLength(body, "utf8"),
    truncated: false,
  }
}

function hasDetected(signals: SurfaceSignal[]): boolean {
  return signals.some(isDetectedSignal)
}

// Assemble detector fixtures at runtime so repository secret scanning does not
// mistake deliberately inert test inputs for live credentials.
const supabaseAnonFixture = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJyb2xlIjoiYW5vbiJ9",
  "publicsignature000000",
].join(".")
const supabaseServiceFixture = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJyb2xlIjoic2VydmljZV9yb2xlIn0",
  "signature000000000",
].join(".")
const firebaseApiKeyFixture = ["AI", "zaSyPublicFirebaseWebConfiguration000"].join("")
const stripeSecretFixtureValue = ["sk", "live", "1234567890abcdefghijkl"].join("_")

function publicAnonFixture(): SurfaceCollection {
  return makeCollection({
    headers: { ...baselineHeaders },
    body: `<script>const key = "${supabaseAnonFixture}"; createClient("https://project.supabase.co", key);</script>`,
  })
}

function firebaseFixture(): SurfaceCollection {
  return makeCollection({
    headers: { ...baselineHeaders },
    body: `
      <script>
        const firebaseConfig = { apiKey: "${firebaseApiKeyFixture}" };
        const stripe = "pk_live_publicvalue123456";
        const recaptcha = "6Lc_public_site_key_value";
      </script>
    `,
  })
}

function serviceRoleFixture(): SurfaceCollection {
  return makeCollection({
    headers: { ...baselineHeaders },
    body: `<script>const key = "${supabaseServiceFixture}"; createClient("https://project.supabase.co", key);</script>`,
  })
}

function stripeSecretFixture(): SurfaceCollection {
  return makeCollection({
    headers: { ...baselineHeaders },
    body: `<script>const stripe = "${stripeSecretFixtureValue}";</script>`,
  })
}

function headers(h: Record<string, string>): SurfaceCollection {
  return makeCollection({ headers: h })
}

describe("analyzePublicSurface", () => {
  it.each([
    ["Supabase anon JWT", publicAnonFixture, false],
    ["Firebase config", firebaseFixture, false],
    ["Supabase service role", serviceRoleFixture, true],
    [
      "Stripe publishable key",
      () => makeCollection({ headers: { ...baselineHeaders }, body: "pk_live_publicvalue123456" }),
      false,
    ],
    ["Stripe secret key", stripeSecretFixture, true],
    [
      "CSP frame-ancestors",
      () =>
        headers({
          "content-security-policy": "frame-ancestors 'self'",
          "strict-transport-security": "max-age=31536000",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
          "permissions-policy": "camera=()",
        }),
      false,
    ],
  ] as const)(
    "classifies %s without public-key/header false positives",
    (_name, fixture, expected) => {
      expect(hasDetected(analyzePublicSurface(fixture()))).toBe(expected)
    }
  )

  it("reports HSTS only on HTTPS", () => {
    const http = makeCollection({
      seedUrl: "http://example.test/",
      finalOrigin: "http://example.test",
      body: "<html></html>",
    })
    const httpsMissing = makeCollection({
      headers: {},
    })
    const httpSignals = analyzePublicSurface(http)
    const httpsSignals = analyzePublicSurface(httpsMissing)
    expect(httpSignals.some((s) => s.id.includes("hsts-missing"))).toBe(false)
    expect(httpsSignals.some((s) => s.id.includes("hsts-missing"))).toBe(true)
  })

  it("reports nosniff only when missing", () => {
    const missing = makeCollection({
      headers: { "strict-transport-security": "max-age=31536000" },
    })
    const present = makeCollection({
      headers: {
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
      },
    })
    expect(analyzePublicSurface(missing).some((s) => s.title.includes("MIME sniffing"))).toBe(true)
    expect(analyzePublicSurface(present).some((s) => s.title.includes("MIME sniffing"))).toBe(false)
  })

  it("reports missing Referrer Policy and Permissions Policy", () => {
    const signals = analyzePublicSurface(
      headers({
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
      })
    )
    expect(signals.some((s) => s.title.includes("Referrer Policy"))).toBe(true)
    expect(signals.some((s) => s.title.includes("Permissions Policy"))).toBe(true)
  })

  it("reports sensitive cookie missing Secure, HttpOnly, and SameSite", () => {
    const collection = makeCollection({
      headers: {
        "set-cookie": "sessionToken=super-secret-value; Path=/",
      },
    })
    const signal = analyzePublicSurface(collection).find((s) =>
      s.title.includes("Sensitive cookie")
    )
    expect(signal).toBeDefined()
    expect(signal?.severity).toBe("HIGH")
    expect(JSON.stringify(signal)).not.toContain("super-secret-value")
  })

  it("reports mixed content on an HTTPS page", () => {
    const collection = makeCollection({
      body: '<script src="http://cdn.evil.test/x.js"></script>',
    })
    expect(analyzePublicSurface(collection).some((s) => s.title.includes("HTTP content"))).toBe(
      true
    )
  })

  it("reports verbose error signatures", () => {
    const collection = makeCollection({
      body: "<pre>Error: failed\n at handler (/srv/app/routes/users.js:42:7)</pre>",
    })
    expect(analyzePublicSurface(collection).some((s) => s.title.includes("Verbose error"))).toBe(
      true
    )
  })

  it("reports a referenced production source map", () => {
    const collection = makeCollection({
      body: '<script src="/assets/app.js.map"></script>',
    })
    expect(analyzePublicSurface(collection).some((s) => s.title.includes("Source map"))).toBe(true)
  })

  it("omits matched secret values from JSON.stringify", () => {
    const collection = stripeSecretFixture()
    const signals = analyzePublicSurface(collection)
    const serialized = JSON.stringify(signals)
    expect(serialized).toContain("high-confidence secret pattern")
    expect(serialized).not.toContain(stripeSecretFixtureValue)
  })

  it("observes data layers without reporting them as secrets", () => {
    const collection = firebaseFixture()
    const signals = analyzePublicSurface(collection)
    const dataLayer = signals.find((s) => s.id.includes("data-layer"))
    expect(dataLayer?.state).toBe("OBSERVED")
  })

  it("observes framework markers", () => {
    const collection = makeCollection({ body: "<html>Built with Lovable</html>" })
    const framework = analyzePublicSurface(collection).find((s) => s.id.includes("framework"))
    expect(framework?.state).toBe("OBSERVED")
  })

  it("returns deterministic IDs based on subject URL", () => {
    const a = makeCollection({ seedUrl: "https://a.test/" })
    const b = makeCollection({ seedUrl: "https://b.test/" })
    const aSignal = analyzePublicSurface(a).find((s) => s.id.includes("hsts-missing"))
    const bSignal = analyzePublicSurface(b).find((s) => s.id.includes("hsts-missing"))
    expect(aSignal?.id).not.toBe(bSignal?.id)
    expect(aSignal?.id).toMatch(/^surface\.hsts-missing\./)
  })
})
