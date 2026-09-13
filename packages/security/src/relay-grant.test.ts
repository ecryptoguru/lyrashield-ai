// security-scan-skip-file: test fixtures use attacker-shaped values intentionally
import { describe, expect, it } from "vitest"
import {
  mintRelayGrant,
  normalizeRelayHost,
  relayHostAllowed,
  relayMethodAllowed,
  relayPathAllowed,
  verifyRelayGrant,
  type RelayGrantScope,
} from "./relay-grant"

const SECRET = "test-signing-secret-0123456789abcdef"

const baseScope: RelayGrantScope = {
  v: 1,
  scanId: "scan_test_1",
  hosts: ["app.example.com", "api.example.com"],
  methods: ["GET", "HEAD", "OPTIONS", "POST"],
  blockedPaths: ["/admin", "/logout"],
  exp: Date.now() + 60_000,
  maxRequests: 500,
  maxBytes: 20 * 1024 * 1024,
  ratePerMinute: 120,
  perPathPerMinute: 20,
}

describe("relay grant", () => {
  it("round-trips a minted grant", () => {
    const token = mintRelayGrant(baseScope, SECRET)
    const verified = verifyRelayGrant(token, SECRET)
    expect(verified).toMatchObject({ ok: true })
    if (verified.ok) {
      expect(verified.scope.scanId).toBe("scan_test_1")
      expect(verified.scope.hosts).toEqual(["api.example.com", "app.example.com"])
    }
  })

  it("rejects a tampered payload", () => {
    const token = mintRelayGrant(baseScope, SECRET)
    const [prefix, sig] = [token.slice(0, token.lastIndexOf(".")), token.split(".").at(-1)]
    const forgedScope = { ...baseScope, hosts: ["evil.example.com"] }
    const forgedPayload = Buffer.from(JSON.stringify(forgedScope)).toString("base64url")
    const forged = `lrg1.${forgedPayload}.${sig}`
    expect(verifyRelayGrant(forged, SECRET)).toEqual({ ok: false, reason: "bad_signature" })
    expect(prefix.length).toBeGreaterThan(0)
  })

  it("rejects a wrong-secret signature", () => {
    const token = mintRelayGrant(baseScope, "other-secret")
    expect(verifyRelayGrant(token, SECRET)).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects expired grants", () => {
    const expired = mintRelayGrant({ ...baseScope, exp: Date.now() - 1 }, SECRET)
    expect(verifyRelayGrant(expired, SECRET)).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects malformed tokens", () => {
    expect(verifyRelayGrant(undefined, SECRET)).toEqual({ ok: false, reason: "malformed" })
    expect(verifyRelayGrant("nope", SECRET)).toEqual({ ok: false, reason: "malformed" })
    expect(verifyRelayGrant("lrg1.notjson.sig", SECRET)).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("enforces host scope with subdomain inheritance", () => {
    expect(relayHostAllowed(baseScope, "app.example.com")).toBe(true)
    expect(relayHostAllowed(baseScope, "API.EXAMPLE.COM")).toBe(true)
    expect(relayHostAllowed(baseScope, "sub.app.example.com")).toBe(true)
    expect(relayHostAllowed(baseScope, "example.com")).toBe(false)
    expect(relayHostAllowed(baseScope, "evilapp.example.com.evil.io")).toBe(false)
    expect(relayHostAllowed(baseScope, "appexample.com")).toBe(false)
  })

  it("enforces method and path scope", () => {
    expect(relayMethodAllowed(baseScope, "post")).toBe(true)
    expect(relayMethodAllowed(baseScope, "DELETE")).toBe(false)
    expect(relayPathAllowed(baseScope, "/api/users")).toBe(true)
    expect(relayPathAllowed(baseScope, "/admin/users")).toBe(false)
    expect(relayPathAllowed(baseScope, "/logout?next=/")).toBe(false)
  })

  it("normalizes exotic hostnames consistently", () => {
    expect(normalizeRelayHost("EXAMPLE.COM.")).toBe("example.com")
    expect(normalizeRelayHost("[::1]")).toBe("::1")
    expect(normalizeRelayHost("")).toBeNull()
  })
})
