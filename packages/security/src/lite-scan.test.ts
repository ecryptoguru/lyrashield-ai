import { describe, expect, it } from "vitest"
import { analyzeLiteSurface, LITE_CHECK_VERSION } from "./lite-scan"

const baselineHeaders = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=()",
}

function scan(text: string) {
  return analyzeLiteSurface({
    target: "https://example.test",
    html: text,
    headers: baselineHeaders,
  })
}

function fixture(...parts: string[]) {
  return parts.join("")
}

describe("Lite Check detector", () => {
  it("uses a versioned deterministic result model", () => {
    const result = scan("<html></html>")
    expect(result.version).toBe(LITE_CHECK_VERSION)
    expect(result.disclaimers.join(" ")).toContain("isn't a guarantee")
  })

  it("does not label public-by-design values as exposed secrets", () => {
    const supabaseAnon = fixture(
      "eyJhbGciOiJIUzI1NiJ9.",
      "eyJyb2xlIjoiYW5vbiJ9.",
      "publicsignature000000"
    )
    const firebaseWebKey = fixture("AIzaSy", "PublicFirebaseWebConfiguration000")
    const publicValues = `
      const supabaseAnon = "${supabaseAnon}"
      const firebaseConfig = { ${fixture("api", "Key")}: "${firebaseWebKey}" }
      const stripe = "pk_live_1234567890abcdefghijkl"
      const recaptcha = "6Lc_public_site_key_value"
      createClient("https://project.supabase.co", supabaseAnon)
    `
    const result = scan(publicValues)
    expect(result.checks).not.toContainEqual(
      expect.objectContaining({ category: "exposed_secrets", severity: "needs_attention" })
    )
    expect(result.checks).toContainEqual(
      expect.objectContaining({ category: "data_layer", severity: "worth_reviewing" })
    )
  })

  it.each([
    fixture('const stripeSecret = "', "sk_", "live_1234567890abcdefghijkl", '"'),
    fixture('const openAi = "', "sk-", "proj-1234567890abcdefghijklmnop", '"'),
    fixture('const github = "', "ghp_", "1234567890abcdefghijklmnopqrstuvwxyzAB", '"'),
    fixture("PRIVATE_", 'KEY="', "1234567890abcdefghijklmnop", '"'),
    fixture("-----BEGIN ", "PRIVATE KEY-----"),
  ])("detects a genuine secret without returning its value", (fixture) => {
    const serialized = JSON.stringify(scan(fixture))
    expect(serialized).toContain("high-confidence secret pattern")
    expect(serialized).not.toContain(fixture)
  })

  it("detects a Supabase service_role JWT but not an anon JWT", () => {
    const service = fixture(
      "eyJhbGciOiJIUzI1NiJ9.",
      "eyJyb2xlIjoic2VydmljZV9yb2xlIn0.",
      "signature000000000"
    )
    expect(scan(service).checks).toContainEqual(
      expect.objectContaining({ category: "exposed_secrets", severity: "needs_attention" })
    )
  })

  it("keeps missing headers factual and non-absolute", () => {
    const result = analyzeLiteSurface({
      target: "https://example.test",
      html: "<html></html>",
      headers: {},
    })
    expect(result.checks.filter((check) => check.category === "security_headers").length).toBe(6)
    expect(JSON.stringify(result)).not.toMatch(/no vulnerabilities|your app is secure/i)
  })

  it("only reports an RLS review signal and never claims active testing", () => {
    const result = scan('createClient("https://project.supabase.co", "public")')
    const signal = result.checks.find((check) => check.category === "data_layer")
    expect(signal?.severity).toBe("worth_reviewing")
    expect(signal?.whyItMatters).toContain("did not query")
  })

  it("flags a public source-map reference without fetching or publishing its path", () => {
    const result = scan("//# sourceMappingURL=app.production.js.map")
    const signal = result.checks.find((check) => check.category === "framework")
    expect(signal).toMatchObject({ severity: "worth_reviewing" })
    expect(JSON.stringify(signal)).not.toContain("app.production.js.map")
  })
})
