import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("two-factor enrollment UI security contract", () => {
  // Runtime client-call assertions live in security-actions.runtime.test.tsx.
  const source = readFileSync(new URL("./two-factor-security.tsx", import.meta.url), "utf8")

  it("offers password recovery to users enrolling an authenticator", () => {
    expect(source).toContain('autoComplete="current-password"')
    expect(source).toContain('href="/forgot-password"')
    expect(source).toContain("Signed up with a social provider")
  })

  it("exposes recovery material without an external QR service", () => {
    expect(source).toContain("data.totpURI")
    expect(source).toContain("data.backupCodes")
    expect(source).toContain("<QRCodeSVG")
    expect(source).toContain("value={setup.totpURI}")
    expect(source).toContain('title="Authenticator setup QR code"')
    expect(source).toContain("Generated only in this browser")
    expect(source).not.toMatch(/qrserver|chart\.google|external.*qr/i)
  })
})
