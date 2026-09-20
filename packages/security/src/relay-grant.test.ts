// security-scan-skip-file: test fixtures use attacker-shaped values intentionally
import { createHmac, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  mintRelayGrant,
  normalizeRelayHost,
  relayHostAllowed,
  relayMethodAllowed,
  relayPathAllowed,
  relaySessionHostAllowed,
  validateRelaySessionBinding,
  verifyRelayGrant,
  type RelayGrantScope,
} from "./relay-grant"

const SECRET = randomBytes(32).toString("hex")

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
    expect(verifyRelayGrant("lrg1.notjson.sig", SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it.each([
    null,
    [],
    { ...baseScope, hosts: [null] },
    { ...baseScope, methods: [4] },
    { ...baseScope, blockedPaths: [null] },
    { ...baseScope, maxBytes: null },
    { ...baseScope, maxRequests: -1 },
    { ...baseScope, ratePerMinute: 1.5 },
    { ...baseScope, perPathPerMinute: "100" },
    { ...baseScope, exp: Date.now() + 48 * 60 * 60 * 1000 },
    { ...baseScope, injectHeaders: { authorization: "secret" } },
  ])("rejects malformed authenticated scope %j", (scope) => {
    const payload = Buffer.from(JSON.stringify(scope)).toString("base64url")
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url")
    expect(verifyRelayGrant(`lrg1.${payload}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: "malformed",
    })
  })

  it.each([
    "//admin",
    "///admin",
    "/%61dmin",
    "/%2561dmin",
    "/x/../admin",
    "/admin%2fusers",
    "/%zz",
  ])("denies encoded or ambiguous blocked path %s", (path) => {
    expect(relayPathAllowed(baseScope, path)).toBe(false)
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

  it("round-trips a grant carrying the optional per-response byte cap", () => {
    const scope = { ...baseScope, maxResponseBytes: 1_048_576 }
    const verified = verifyRelayGrant(mintRelayGrant(scope, SECRET), SECRET)
    expect(verified).toMatchObject({ ok: true })
    if (verified.ok) expect(verified.scope.maxResponseBytes).toBe(1_048_576)
  })

  it.each([0, -1, 1.5, "1048576", 64 * 1024 * 1024 + 1])(
    "rejects malformed maxResponseBytes %j",
    (maxResponseBytes) => {
      const payload = Buffer.from(JSON.stringify({ ...baseScope, maxResponseBytes })).toString(
        "base64url"
      )
      const signature = createHmac("sha256", SECRET).update(payload).digest("base64url")
      expect(verifyRelayGrant(`lrg1.${payload}.${signature}`, SECRET)).toEqual({
        ok: false,
        reason: "malformed",
      })
    }
  )
})

describe("relay session binding", () => {
  const binding = {
    headers: { authorization: "Bearer test-session-material" },
    hosts: ["app.example.com"],
    // Inside the grant's expiry — the binding can never outlive the grant.
    exp: baseScope.exp - 1_000,
  }

  it("accepts a binding narrower than the grant scope", () => {
    const result = validateRelaySessionBinding(baseScope, binding)
    expect(result).toEqual({
      ok: true,
      session: {
        headers: { authorization: "Bearer test-session-material" },
        hosts: ["app.example.com"],
        exp: binding.exp,
      },
    })
  })

  it.each([
    null,
    "session",
    {},
    { ...binding, headers: {} },
    { ...binding, headers: { authorization: "x".repeat(9 * 1024) } },
    { ...binding, headers: { authorization: "line1\r\nline2" } },
    { ...binding, headers: { "x-forwarded-for": "spoof" } },
    { ...binding, headers: { host: "evil.example.com" } },
    { ...binding, hosts: [] },
    { ...binding, hosts: ["evil.example.com"] },
    { ...binding, hosts: ["app.example.com", "sibling.example.com"] },
    { ...binding, hosts: [123] },
    { ...binding, exp: Date.now() - 1 },
    { ...binding, exp: baseScope.exp + 1 },
    { ...binding, exp: "soon" },
  ])("rejects out-of-contract binding %j", (session) => {
    expect(validateRelaySessionBinding(baseScope, session).ok).toBe(false)
  })

  it("keeps the session inside the grant expiry and grant hosts", () => {
    // A subdomain of a scoped host is a valid narrowing.
    const narrowed = validateRelaySessionBinding(baseScope, {
      ...binding,
      hosts: ["sub.app.example.com"],
    })
    expect(narrowed.ok).toBe(true)
    // The apex of a scoped host is NOT — the session can never widen scope.
    const widened = validateRelaySessionBinding(
      { ...baseScope, hosts: ["app.example.com"] },
      { ...binding, hosts: ["example.com"] }
    )
    expect(widened).toEqual({ ok: false, reason: "session_out_of_scope" })
  })

  it("matches only session-scoped hosts for injection", () => {
    const validated = validateRelaySessionBinding(baseScope, binding)
    if (!validated.ok) throw new Error("fixture should validate")
    expect(relaySessionHostAllowed(validated.session, "app.example.com")).toBe(true)
    expect(relaySessionHostAllowed(validated.session, "sub.app.example.com")).toBe(true)
    expect(relaySessionHostAllowed(validated.session, "api.example.com")).toBe(false)
  })
})
