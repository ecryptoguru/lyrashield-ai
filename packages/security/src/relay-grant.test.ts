// security-scan-skip-file: test fixtures use attacker-shaped values intentionally
import { createHmac, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  connectorRelayScope,
  mintConnectorRelayGrant,
  isConnectorRelayProvider,
  mintRelayGrant,
  normalizeRelayHost,
  relayHostAllowed,
  relayMethodAllowed,
  relayPathAllowed,
  relaySessionHostAllowed,
  validateRelaySessionBinding,
  verifyRelayGrant,
  MAX_RELAY_GRANT_TTL_MS,
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

describe("connector relay scope", () => {
  it("mints a valid grant pinned to the provider host and read-only methods", () => {
    const { grant, scope } = mintConnectorRelayGrant("scan_conn_1", "github", 60_000, SECRET)
    expect(scope.scanId).toBe("scan_conn_1")
    expect(scope.hosts).toEqual(["api.github.com"])
    expect(scope.methods).toEqual(["GET", "HEAD"])
    const verified = verifyRelayGrant(grant, SECRET)
    expect(verified).toMatchObject({ ok: true })
  })

  it("slack profile allows GET only, github allows GET/HEAD, both deny writes", () => {
    const slackScope = connectorRelayScope("s1", "slack", 60_000)
    expect(slackScope.methods).toEqual(["GET"])
    expect(relayMethodAllowed(slackScope, "POST")).toBe(false)
    expect(relayMethodAllowed(slackScope, "DELETE")).toBe(false)
    expect(relayHostAllowed(slackScope, "slack.com")).toBe(true)
    expect(relayHostAllowed(slackScope, "api.github.com")).toBe(false)
    expect(relayHostAllowed(slackScope, "slack.com.evil.io")).toBe(false)

    const ghScope = connectorRelayScope("s1", "github", 60_000)
    expect(relayMethodAllowed(ghScope, "GET")).toBe(true)
    expect(relayMethodAllowed(ghScope, "HEAD")).toBe(true)
    expect(relayMethodAllowed(ghScope, "PATCH")).toBe(false)
    expect(relayHostAllowed(ghScope, "api.github.com")).toBe(true)
    // Subdomain inheritance stays inside the host, not sideways.
    expect(relayHostAllowed(ghScope, "uploads.github.com")).toBe(false)
  })

  it("a minted connector grant verifies and enforces every existing control", () => {
    const { grant, scope } = mintConnectorRelayGrant("scan_conn_2", "github", 30_000, SECRET)
    const verified = verifyRelayGrant(grant, SECRET)
    expect(verified).toMatchObject({ ok: true })
    if (verified.ok) {
      // Verified scope is identical to the minted scope — signature integrity.
      expect(verified.scope).toEqual(scope)
    }
    // Expiry is enforced on connector grants like any other grant.
    const expired = mintRelayGrant({ ...scope, exp: Date.now() - 1 }, SECRET)
    expect(verifyRelayGrant(expired, SECRET)).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects TTLs outside the global grant bounds", () => {
    expect(() => connectorRelayScope("s1", "github", 0)).toThrow()
    expect(() => connectorRelayScope("s1", "github", -1)).toThrow()
    expect(() => connectorRelayScope("s1", "github", MAX_RELAY_GRANT_TTL_MS + 1)).toThrow()
    expect(() => connectorRelayScope("s1", "github", MAX_RELAY_GRANT_TTL_MS)).not.toThrow()
  })

  it("rejects unknown providers", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => connectorRelayScope("s1", "ftp" as any, 60_000)).toThrow()
    expect(isConnectorRelayProvider("github")).toBe(true)
    expect(isConnectorRelayProvider("ftp")).toBe(false)
  })

  it("never carries credential material — the payload is only the signed scope", () => {
    const { grant } = mintConnectorRelayGrant("scan_conn_3", "slack", 60_000, SECRET)
    const payload = JSON.parse(
      Buffer.from(grant.split(".")[1]!, "base64url").toString("utf8")
    ) as Record<string, unknown>
    // The grant contract is the scope only; tokens, headers and bearer
    // material must never appear — callers resolve credentials separately.
    for (const key of Object.keys(payload)) {
      expect(key).not.toMatch(/token|secret|authorization|credential|header/i)
    }
    expect(payload).toMatchObject({ v: 1, scanId: "scan_conn_3" })
  })

  it("scope enforcement blocks anything a connector grant does not list", () => {
    // Signature validity is not authorization: the enforcement layer only
    // allows the hosts/methods the scope itself lists, and connector profiles
    // pin those lists to the provider's read surface.
    const { scope } = mintConnectorRelayGrant("scan_conn_4", "slack", 60_000, SECRET)
    expect(relayHostAllowed(scope, "slack.com")).toBe(true)
    expect(relayHostAllowed(scope, "files.slack.com")).toBe(true) // subdomain of listed host
    expect(relayHostAllowed(scope, "hooks.slack.com.evil.io")).toBe(false)
    expect(relayMethodAllowed(scope, "POST")).toBe(false)
    expect(relayPathAllowed(scope, "/api/conversations.history")).toBe(true)
  })

  it("connector grants inherit the global structural bound checks", () => {
    // A signed but oversized connector scope is still rejected at verify —
    // the profile caps sit comfortably under the global caps, and grants
    // claiming beyond the global ceiling are malformed regardless of source.
    const oversized: RelayGrantScope = {
      v: 1,
      scanId: "s1",
      hosts: ["api.github.com"],
      methods: ["GET"],
      blockedPaths: [],
      exp: Date.now() + 60_000,
      maxRequests: 200_000, // beyond the 100k global cap
      maxBytes: 4 * 1024 * 1024,
      ratePerMinute: 60,
      perPathPerMinute: 60,
    }
    const forged = mintRelayGrant(oversized, SECRET)
    expect(verifyRelayGrant(forged, SECRET)).toEqual({ ok: false, reason: "malformed" })
  })
})
