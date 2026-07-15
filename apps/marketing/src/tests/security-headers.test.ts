import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const middleware = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8")

describe("Cloudflare marketing security headers", () => {
  it("applies a defensive browser policy to every public route", () => {
    expect(headers).toContain("/*")
    expect(headers).toContain("Content-Security-Policy:")
    expect(headers).toContain("https://static.cloudflareinsights.com")
    expect(headers).toContain("https://cloudflareinsights.com")
    expect(headers).toContain("frame-ancestors 'none'")
    expect(headers).toContain("Strict-Transport-Security:")
    expect(headers).toContain("X-Content-Type-Options: nosniff")
    expect(headers).toContain("Referrer-Policy: strict-origin-when-cross-origin")
    expect(headers).toContain("Permissions-Policy:")
  })

  it("applies the same defensive policy and no-store indexing boundary to Worker API responses", () => {
    expect(middleware).toContain('"Content-Security-Policy"')
    expect(middleware).toContain('"Strict-Transport-Security"')
    expect(middleware).toContain('"X-Content-Type-Options"')
    expect(middleware).toContain('url.pathname.startsWith("/api/")')
    expect(middleware).toContain('headers.set("Cache-Control", "no-store")')
    expect(middleware).toContain('headers.set("X-Robots-Tag", "noindex")')
  })
})
