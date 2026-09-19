import { createHmac, timingSafeEqual } from "node:crypto"
import { domainToASCII } from "node:url"
import { parseIpLiteral } from "./ssrf"

/**
 * Scan-scoped target-relay grants.
 *
 * The sandboxed engine has no route to arbitrary hosts; for URL targets the
 * worker mints a signed grant authorizing the relay to forward traffic to the
 * verified host(s) only. Grants are HMAC-signed — the relay verifies without
 * a database — and are revocable by scanId. The grant is the scope contract:
 * host list, method allowlist, path denials, rate/byte/request caps.
 */

export interface RelayGrantScope {
  v: 1
  scanId: string
  /** Verified hostnames (normalized, lower-case). Subdomains of a verified apex inherit scope. */
  hosts: string[]
  /** Upper-case method allowlist. */
  methods: string[]
  /** Denied path prefixes (e.g. "/admin", "/logout"). */
  blockedPaths: string[]
  /** Grant expiry, epoch ms. */
  exp: number
  maxRequests: number
  /** Total relayed request and response body bytes budget. */
  maxBytes: number
  /** Sustained request rate cap per scan. */
  ratePerMinute: number
  /** Cap on requests to a single path prefix per minute (anti junk-submission). */
  perPathPerMinute: number
}

export type RelayDenyReason =
  | "malformed"
  | "connect_not_supported"
  | "bad_signature"
  | "expired"
  | "host_out_of_scope"
  | "method_not_allowed"
  | "path_blocked"
  | "revoked"
  | "request_cap"
  | "byte_cap"
  | "rate_limited"

const GRANT_PREFIX = "lrg1."
export const MAX_RELAY_GRANT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_GRANT_LENGTH = 16_384

function canonicalJson(scope: RelayGrantScope): string {
  const ordered: RelayGrantScope = {
    v: scope.v,
    scanId: scope.scanId,
    hosts: [...scope.hosts].sort(),
    methods: [...scope.methods].sort(),
    blockedPaths: [...scope.blockedPaths].sort(),
    exp: scope.exp,
    maxRequests: scope.maxRequests,
    maxBytes: scope.maxBytes,
    ratePerMinute: scope.ratePerMinute,
    perPathPerMinute: scope.perPathPerMinute,
  }
  return JSON.stringify(ordered)
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url")
}

/** Mint a signed grant token. Worker-side; the token itself contains the scope. */
export function mintRelayGrant(scope: RelayGrantScope, secret: string): string {
  const payloadB64 = Buffer.from(canonicalJson(scope), "utf8").toString("base64url")
  return `${GRANT_PREFIX}${payloadB64}.${sign(payloadB64, secret)}`
}

export function verifyRelayGrant(
  token: string | undefined,
  secret: string
): { ok: true; scope: RelayGrantScope } | { ok: false; reason: RelayDenyReason } {
  if (!token || token.length > MAX_GRANT_LENGTH || !token.startsWith(GRANT_PREFIX))
    return { ok: false, reason: "malformed" }
  const body = token.slice(GRANT_PREFIX.length)
  const dot = body.lastIndexOf(".")
  if (dot <= 0) return { ok: false, reason: "malformed" }
  const payloadB64 = body.slice(0, dot)
  const sigB64 = body.slice(dot + 1)

  const expected = sign(payloadB64, secret)
  const a = Buffer.from(sigB64)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" }
  }

  let scope: RelayGrantScope
  try {
    scope = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "malformed" }
  }
  // A valid HMAC authenticates bytes, not their types or policy bounds.
  if (
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    scope.v !== 1 ||
    typeof scope.scanId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.scanId) ||
    !Array.isArray(scope.hosts) ||
    scope.hosts.length === 0 ||
    scope.hosts.length > 100 ||
    !scope.hosts.every(
      (host) => typeof host === "string" && host.length <= 253 && normalizeRelayHost(host) !== null
    ) ||
    !Array.isArray(scope.methods) ||
    scope.methods.length === 0 ||
    !scope.methods.every(
      (method) =>
        typeof method === "string" && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(method)
    ) ||
    !Array.isArray(scope.blockedPaths) ||
    scope.blockedPaths.length > 100 ||
    !scope.blockedPaths.every(
      (path) => typeof path === "string" && path.startsWith("/") && path.length <= 2048
    ) ||
    ![
      scope.exp,
      scope.maxRequests,
      scope.maxBytes,
      scope.ratePerMinute,
      scope.perPathPerMinute,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    scope.exp > Date.now() + MAX_RELAY_GRANT_TTL_MS ||
    scope.maxRequests > 100_000 ||
    scope.maxBytes > 1024 * 1024 * 1024 ||
    scope.ratePerMinute > 10_000 ||
    scope.perPathPerMinute > 10_000 ||
    // Signed grants are readable by their bearer. Never put credentials in them.
    "injectHeaders" in scope
  ) {
    return { ok: false, reason: "malformed" }
  }
  if (scope.exp <= Date.now()) return { ok: false, reason: "expired" }
  return { ok: true, scope }
}

/** Normalize a hostname the same way the SSRF guard does. */
export function normalizeRelayHost(host: string): string | null {
  let h = host.trim().toLowerCase()
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1)
  if (h.endsWith(".")) h = h.slice(0, -1)
  const literal = parseIpLiteral(h)
  if (literal !== null) return literal
  try {
    const normalized = domainToASCII(h.normalize("NFKC"))
    return normalized || null
  } catch {
    return null
  }
}

/** Exact host or subdomain-of-verified-apex. DNS TXT on the apex proves domain control. */
export function relayHostAllowed(scope: RelayGrantScope, rawHost: string): boolean {
  const host = normalizeRelayHost(rawHost)
  if (!host) return false
  return scope.hosts.some((scoped) => {
    const s = normalizeRelayHost(scoped)
    return s !== null && (host === s || host.endsWith(`.${s}`))
  })
}

export function relayMethodAllowed(scope: RelayGrantScope, method: string): boolean {
  return scope.methods.includes(method.toUpperCase())
}

/** Decode and normalize router paths; ambiguous encodings fail closed. */
export function normalizeRelayPath(value: string): string | null {
  try {
    let decoded = value.split("?")[0] ?? ""
    for (let i = 0; i < 5; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded)
        return new URL(
          `http://relay.invalid${decoded.replaceAll("\\", "/").replace(/\/{2,}/g, "/")}`
        ).pathname
      decoded = next
    }
  } catch {
    /* malformed encoding */
  }
  return null
}

export function relayPathAllowed(scope: RelayGrantScope, path: string): boolean {
  const normalized = normalizeRelayPath(path)
  if (normalized === null) return false
  return !scope.blockedPaths.some((blocked) => {
    const prefix = normalizeRelayPath(blocked)
    return prefix === null || normalized.startsWith(prefix)
  })
}

// ── Outbound connector scopes ───────────────────────────────────────────────
// Connector tools (packages/integrations/src/connectors) run through the same
// scoped relay as live-target traffic. The grant is the read-only contract:
// each provider pins its exact API host and GET/HEAD only, so a tool bug or
// tampered request cannot smuggle a write method through the egress path.

export type ConnectorRelayProvider = "github" | "slack"

export interface ConnectorRelayProfile {
  hosts: string[]
  methods: string[]
  maxRequests: number
  maxBytes: number
  ratePerMinute: number
  perPathPerMinute: number
}

export const CONNECTOR_RELAY_PROFILES: Record<ConnectorRelayProvider, ConnectorRelayProfile> = {
  github: {
    hosts: ["api.github.com"],
    methods: ["GET", "HEAD"],
    maxRequests: 200,
    maxBytes: 8 * 1024 * 1024,
    ratePerMinute: 60,
    perPathPerMinute: 60,
  },
  slack: {
    hosts: ["slack.com"],
    methods: ["GET"],
    maxRequests: 100,
    maxBytes: 4 * 1024 * 1024,
    ratePerMinute: 30,
    perPathPerMinute: 30,
  },
}

export function isConnectorRelayProvider(value: string): value is ConnectorRelayProvider {
  return value === "github" || value === "slack"
}

/**
 * The relay scope for one scan's connector egress. `ttlMs` is bounded by the
 * global grant TTL — a grant that outlives its scan is rejected at verify
 * time anyway, so minting refuses rather than emitting a dead grant.
 */
export function connectorRelayScope(
  scanId: string,
  provider: ConnectorRelayProvider,
  ttlMs: number,
  now = Date.now()
): RelayGrantScope {
  const profile = CONNECTOR_RELAY_PROFILES[provider]
  if (!profile) throw new Error(`Unknown connector provider: ${provider}`)
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_RELAY_GRANT_TTL_MS) {
    throw new Error("Connector grant TTL is outside the allowed bounds")
  }
  return {
    v: 1,
    scanId,
    hosts: [...profile.hosts],
    methods: [...profile.methods],
    blockedPaths: [],
    exp: now + ttlMs,
    maxRequests: profile.maxRequests,
    maxBytes: profile.maxBytes,
    ratePerMinute: profile.ratePerMinute,
    perPathPerMinute: profile.perPathPerMinute,
  }
}

/** Mint a signed connector-scoped grant. Worker-side; the token carries the scope. */
export function mintConnectorRelayGrant(
  scanId: string,
  provider: ConnectorRelayProvider,
  ttlMs: number,
  secret: string,
  now = Date.now()
): { grant: string; scope: RelayGrantScope } {
  const scope = connectorRelayScope(scanId, provider, ttlMs, now)
  return { grant: mintRelayGrant(scope, secret), scope }
}
