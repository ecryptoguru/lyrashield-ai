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
  /** Total relayed body+CONNECT bytes budget. */
  maxBytes: number
  /** Sustained request rate cap per scan. */
  ratePerMinute: number
  /** Cap on requests to a single path prefix per minute (anti junk-submission). */
  perPathPerMinute: number
  /** Headers the relay injects server-side — credentials never enter the sandbox. */
  injectHeaders?: Record<string, string>
}

export type RelayDenyReason =
  | "malformed"
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
    ...(scope.injectHeaders
      ? { injectHeaders: Object.fromEntries(Object.entries(scope.injectHeaders).sort()) }
      : {}),
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
  if (!token || !token.startsWith(GRANT_PREFIX)) return { ok: false, reason: "malformed" }
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
  if (
    scope.v !== 1 ||
    typeof scope.scanId !== "string" ||
    !Array.isArray(scope.hosts) ||
    !Array.isArray(scope.methods) ||
    typeof scope.exp !== "number" ||
    !Array.isArray(scope.blockedPaths)
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

export function relayPathAllowed(scope: RelayGrantScope, path: string): boolean {
  return !scope.blockedPaths.some((blocked) => path.startsWith(blocked))
}
