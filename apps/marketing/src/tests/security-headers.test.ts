import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import marketingCsp from "../lib/marketing-csp.json"

const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8")
const middleware = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8")
const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
const csp = marketingCsp.directives.join("; ")

describe("Cloudflare marketing security headers", () => {
  it("applies a defensive browser policy to every public route", () => {
    expect(headers).toContain("/*")
    expect(headers).toContain("Content-Security-Policy:")
    expect(headers).toContain("https://us.i.posthog.com")
    expect(headers).not.toContain("https://pulse.lyrashieldai.com")
    expect(headers).toContain("https://us-assets.i.posthog.com")
    expect(headers).toContain("https://static.cloudflareinsights.com")
    expect(headers).toContain("https://cloudflareinsights.com")
    expect(headers).toContain("media-src 'self' blob: https://media.lyrashieldai.com")
    expect(headers).toContain("https://media.lyrashieldai.com")
    expect(headers).toContain("frame-ancestors 'none'")
    expect(headers).toContain("Strict-Transport-Security:")
    expect(headers).toContain("X-Content-Type-Options: nosniff")
    expect(headers).toContain("Referrer-Policy: strict-origin-when-cross-origin")
    expect(headers).toContain("Permissions-Policy:")
    expect(headers).toContain("tools=(self)")
    expect(headers).toContain("Origin-Agent-Cluster: ?1")
  })

  it("sends production analytics to the signed-in US project endpoint", () => {
    expect(wrangler).toContain('"PUBLIC_POSTHOG_HOST": "https://us.i.posthog.com"')
  })

  it("uses one script policy for static assets and Worker responses without inline execution", () => {
    expect(headers).toContain(`  Content-Security-Policy: ${csp}\n`)
    const scriptDirective = marketingCsp.directives.find((directive) =>
      directive.startsWith("script-src ")
    )
    expect(scriptDirective).not.toContain("'unsafe-inline'")
    expect(middleware).toContain('marketingCsp.directives.join("; ")')
  })

  it("applies the same defensive policy and no-store indexing boundary to Worker API responses", () => {
    expect(middleware).toContain('"Content-Security-Policy"')
    expect(middleware).toContain('"Strict-Transport-Security"')
    expect(middleware).toContain('"X-Content-Type-Options"')
    expect(middleware).toContain('url.pathname.startsWith("/api/")')
    expect(middleware).toContain('headers.set("Cache-Control", "no-store")')
    expect(middleware).toContain('headers.set("X-Robots-Tag", "noindex")')
  })

  it("keeps static and Worker security header values identical for the catch-all route", () => {
    // Extract only the /* route headers (not route-specific cache rules)
    const catchAllBlock = headers.split("\n\n")[0]
    const staticHeaders = catchAllBlock
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "/*")

    for (const line of staticHeaders) {
      const separator = line.indexOf(":")
      const name = line.slice(0, separator)
      const value = line.slice(separator + 1).trim()
      if (name === "Content-Security-Policy") continue // checked against the imported policy above
      expect(middleware).toContain(JSON.stringify(name))
      expect(middleware).toContain(JSON.stringify(value))
    }
  })
})
