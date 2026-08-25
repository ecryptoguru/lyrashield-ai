import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("two-factor enrollment UI security contract", () => {
  // apps/web has no component test harness; preserve the critical client-call contract here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL("./two-factor-security.tsx", import.meta.url), "utf8")

  it("requires a password and requests only TOTP enrollment", () => {
    expect(source).toContain("password,")
    expect(source).toContain('method: "totp"')
    expect(source).toContain('autoComplete="current-password"')
    expect(source).toContain('href="/forgot-password"')
    expect(source).toContain("Signed up with a social provider")
  })

  it("never trusts the device and exposes recovery material without an external QR service", () => {
    expect(source).toContain("trustDevice: false")
    expect(source).toContain("data.totpURI")
    expect(source).toContain("data.backupCodes")
    expect(source).toContain("<QRCodeSVG")
    expect(source).toContain("value={setup.totpURI}")
    expect(source).toContain('title="Authenticator setup QR code"')
    expect(source).toContain("Generated only in this browser")
    expect(source).not.toMatch(/qrserver|chart\.google|external.*qr/i)
  })
})
