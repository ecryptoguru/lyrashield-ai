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
  /**
   * Per-response body cap in bytes (optional, additive). The relay's global
   * response ceiling still applies; this narrows it for constrained workflows
   * such as the authenticated staging beta.
   */
  maxResponseBytes?: number
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
    ...(scope.maxResponseBytes !== undefined ? { maxResponseBytes: scope.maxResponseBytes } : {}),
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
    // Optional per-response cap: when present it must be a sane positive bound.
    (scope.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(scope.maxResponseBytes) ||
        scope.maxResponseBytes <= 0 ||
        scope.maxResponseBytes > 64 * 1024 * 1024)) ||
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

/**
 * Scan-scoped test-session binding for the authenticated staging beta.
 *
 * The signed grant is a bearer credential and stays credential-free (the
 * `injectHeaders` field is rejected above). Session material therefore
 * travels separately: the worker registers it over the admin-authenticated
 * `/v1/register` channel alongside the grant, and the relay injects the
 * headers server-side — they never enter the grant, the engine sandbox, the
 * model context, or the audit log.
 */
export interface RelaySessionBinding {
  /** Header name → value pairs injected on in-scope forwarded requests. */
  headers: Record<string, string>
  /** Normalized hostnames the session may be injected for — a subset of the grant hosts. */
  hosts: string[]
  /** Session expiry, epoch ms — never later than the grant expiry. */
  exp: number
}

/** Header names the relay may inject. Anything else is refused at registration. */
export const INJECTABLE_SESSION_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-session-token",
] as const

export const MAX_SESSION_HEADERS = 4
export const MAX_SESSION_HEADER_VALUE_BYTES = 8 * 1024
export const MAX_SESSION_HOSTS = 8

export type RelaySessionDenyReason =
  "session_malformed" | "session_header_not_allowed" | "session_out_of_scope" | "session_expired"

/**
 * Validate a session binding against an already-verified grant scope. The
 * binding may only NARROW the grant — hosts must be a subset of the grant's
 * scope and the expiry cannot outlive it.
 */
export function validateRelaySessionBinding(
  scope: RelayGrantScope,
  session: unknown
): { ok: true; session: RelaySessionBinding } | { ok: false; reason: RelaySessionDenyReason } {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return { ok: false, reason: "session_malformed" }
  }
  const candidate = session as Record<string, unknown>
  const headers = candidate.headers
  const hosts = candidate.hosts
  const exp = candidate.exp

  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    !Array.isArray(hosts) ||
    hosts.length === 0 ||
    hosts.length > MAX_SESSION_HOSTS ||
    !Number.isSafeInteger(exp)
  ) {
    return { ok: false, reason: "session_malformed" }
  }
  // The binding can never outlive the grant, and an already-expired session
  // admits nothing.
  if ((exp as number) <= Date.now()) return { ok: false, reason: "session_expired" }
  if ((exp as number) > scope.exp) return { ok: false, reason: "session_out_of_scope" }

  const headerEntries = Object.entries(headers as Record<string, unknown>)
  if (headerEntries.length === 0 || headerEntries.length > MAX_SESSION_HEADERS) {
    return { ok: false, reason: "session_malformed" }
  }
  for (const [name, value] of headerEntries) {
    const normalizedName = name.trim().toLowerCase()
    if (
      !INJECTABLE_SESSION_HEADERS.includes(
        normalizedName as (typeof INJECTABLE_SESSION_HEADERS)[number]
      ) ||
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_SESSION_HEADER_VALUE_BYTES ||
      /[\r\n]/.test(value)
    ) {
      return { ok: false, reason: "session_header_not_allowed" }
    }
  }

  const normalizedHosts: string[] = []
  for (const raw of hosts) {
    if (typeof raw !== "string") return { ok: false, reason: "session_malformed" }
    const normalized = normalizeRelayHost(raw)
    if (!normalized || !relayHostAllowed(scope, normalized)) {
      return { ok: false, reason: "session_out_of_scope" }
    }
    normalizedHosts.push(normalized)
  }

  return {
    ok: true,
    session: {
      headers: Object.fromEntries(
        headerEntries.map(([name, value]) => [name.trim().toLowerCase(), value as string])
      ),
      hosts: normalizedHosts,
      exp: exp as number,
    },
  }
}

/** Whether a normalized request host may receive the session headers. */
export function relaySessionHostAllowed(session: RelaySessionBinding, host: string): boolean {
  const normalized = normalizeRelayHost(host)
  if (!normalized) return false
  return session.hosts.some((scoped) => normalized === scoped || normalized.endsWith(`.${scoped}`))
}
