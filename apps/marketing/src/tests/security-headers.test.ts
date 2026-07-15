import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8")

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
})
