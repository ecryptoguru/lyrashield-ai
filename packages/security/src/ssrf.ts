import { lookup } from "node:dns/promises"
import net from "node:net"

/**
 * SSRF protection for user-supplied scan-target URLs.
 *
 * Validates that a URL is safe for the platform to fetch server-side:
 *  - only http(s) schemes are allowed
 *  - rejects hostnames that ARE, or RESOLVE TO, private / loopback / link-local /
 *    cloud-metadata / reserved IP ranges (IPv4 and IPv6, incl. IPv4-mapped IPv6)
 *  - handles IPv6 literals with or without brackets, and non-standard IPv4 encodings
 *
 * IMPORTANT: this is create-time validation. The durable defense against DNS
 * rebinding is fetch-time enforcement in the scan worker: resolve once, pin the
 * resolved IP, connect to that IP, and re-validate on every redirect hop.
 * See PRD PART B §B2.2. This helper is intended to be shared with that worker
 * (move to packages/security when that package is created — PRD §B0).
 */

export type SsrfReason =
  | "invalid_url"
  | "invalid_scheme"
  | "empty_host"
  | "trailing_dot"
  | "blocked_hostname"
  | "blocked_ip"
  | "resolves_to_blocked_ip"
  | "dns_resolution_failed"

export type SsrfCheckResult = { safe: true } | { safe: false; reason: SsrfReason }
export type SafeResolutionResult =
  { safe: true; addresses: string[] } | { safe: false; reason: SsrfReason }

/** Injectable resolver so tests don't hit the network. Returns resolved IP strings. */
export type HostResolver = (hostname: string) => Promise<string[]>

const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"])

// ── IPv4 ────────────────────────────────────────────────────────────────────

function parseUintPart(part: string): number | null {
  if (part.length === 0) return null
  let value: number
  if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part.slice(2), 16)
  else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8)
  else if (/^[0-9]+$/.test(part)) value = parseInt(part, 10)
  else return null
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * inet_aton-style parse of an IPv4 literal in dotted/decimal/octal/hex form.
 * Returns canonical dotted-decimal, or null if `host` is not an IPv4 literal.
 * (WHATWG URL already normalizes most of these for http(s); this is defense-in-depth
 * and is also used to canonicalize resolved addresses.)
 */
export function canonicalizeIpv4(host: string): string | null {
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return null
  const values: number[] = []
  for (const p of parts) {
    const v = parseUintPart(p)
    if (v === null) return null
    values.push(v)
  }
  const v0 = values[0] ?? 0
  const v1 = values[1] ?? 0
  const v2 = values[2] ?? 0
  const v3 = values[3] ?? 0
  let ipNum: number
  switch (values.length) {
    case 1:
      if (v0 > 0xffffffff) return null
      ipNum = v0
      break
    case 2:
      if (v0 > 0xff || v1 > 0xffffff) return null
      ipNum = (v0 << 24) | v1
      break
    case 3:
      if (v0 > 0xff || v1 > 0xff || v2 > 0xffff) return null
      ipNum = (v0 << 24) | (v1 << 16) | v2
      break
    default:
      if (v0 > 0xff || v1 > 0xff || v2 > 0xff || v3 > 0xff) return null
      ipNum = (v0 << 24) | (v1 << 16) | (v2 << 8) | v3
  }
  ipNum >>>= 0
  return [(ipNum >>> 24) & 0xff, (ipNum >>> 16) & 0xff, (ipNum >>> 8) & 0xff, ipNum & 0xff].join(
    "."
  )
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | (Number(octet) & 0xff)) >>> 0, 0) >>> 0
}

function inCidrV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

// Private, loopback, link-local, metadata, and reserved IPv4 ranges.
const BLOCKED_V4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network (0.0.0.0/8)
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // RFC6598 CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
]

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_V4_CIDRS.some(([base, bits]) => inCidrV4(ip, base, bits))
}

// ── IPv6 ─────────────────────────────────────────────────────────────────────

/** Expand a (valid) IPv6 literal to 16 bytes, handling "::" and embedded IPv4. */
export function expandIpv6(input: string): number[] | null {
  let ip = input
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1)
  const pct = ip.indexOf("%")
  if (pct !== -1) ip = ip.slice(0, pct) // drop zone id
  if (net.isIP(ip) !== 6) return null

  // Convert a trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) into two hex groups.
  // eslint-disable-next-line security/detect-unsafe-regex
  const embedded = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embedded) {
    const prefix = embedded[1] ?? ""
    const v4 = canonicalizeIpv4(embedded[2] ?? "")
    if (!v4) return null
    const octets = v4.split(".").map(Number)
    const o0 = octets[0] ?? 0
    const o1 = octets[1] ?? 0
    const o2 = octets[2] ?? 0
    const o3 = octets[3] ?? 0
    const g1 = (((o0 << 8) | o1) >>> 0).toString(16)
    const g2 = (((o2 << 8) | o3) >>> 0).toString(16)
    ip = `${prefix}${g1}:${g2}`
  }

  const halves = ip.split("::")
  if (halves.length > 2) return null
  const h0 = halves[0] ?? ""
  const h1 = halves.length === 2 ? (halves[1] ?? "") : null
  const head = h0 ? h0.split(":") : []
  const tail = h1 === null ? null : h1 ? h1.split(":") : []

  let groups: string[]
  if (tail === null) {
    groups = head
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail]
  }
  if (groups.length !== 8) return null

  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
    const v = parseInt(g, 16)
    bytes.push((v >> 8) & 0xff, v & 0xff)
  }
  return bytes
}

function isBlockedIpv6(bytes: number[]): boolean {
  const at = (i: number): number => bytes[i] ?? 0
  const zero = (from: number, to: number): boolean => bytes.slice(from, to).every((x) => x === 0)

  if (zero(0, 16)) return true // :: unspecified
  if (zero(0, 15) && at(15) === 1) return true // ::1 loopback

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 → validate embedded IPv4
  if (zero(0, 10) && at(10) === 0xff && at(11) === 0xff) {
    return isBlockedIpv4(bytes.slice(12, 16).join("."))
  }
  if (zero(0, 12)) return isBlockedIpv4(bytes.slice(12, 16).join("."))

  // NAT64 well-known prefix 64:ff9b::/96 → validate embedded IPv4
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && zero(4, 12)) {
    return isBlockedIpv4(bytes.slice(12, 16).join("."))
  }

  if ((at(0) & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (at(0) === 0xff) return true // ff00::/8 multicast
  return false
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True if `ip` (a valid IPv4/IPv6 string, in any IPv4 encoding) is in a blocked range. */
export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) return isBlockedIpv4(ip)
  if (kind === 6) {
    const bytes = expandIpv6(ip)
    return bytes ? isBlockedIpv6(bytes) : true // fail closed on unparseable v6
  }
  const v4 = canonicalizeIpv4(ip)
  if (v4) return isBlockedIpv4(v4)
  const bytes = expandIpv6(ip)
  if (bytes) return isBlockedIpv6(bytes)
  return false // not an IP literal; caller resolves it as a hostname
}

/** If `host` is an IP literal (bracketed/plain IPv6, or dotted/decimal/octal/hex IPv4), return a canonical IP; else null. */
export function parseIpLiteral(host: string): string | null {
  let h = host
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1)
  const kind = net.isIP(h)
  if (kind === 4 || kind === 6) return h
  return canonicalizeIpv4(h)
}

/**
 * Validate a user-supplied URL for server-side fetching.
 * Rejects non-http(s) schemes and hosts that are — or resolve to — blocked IP ranges.
 */
export async function checkScanUrlSafe(
  rawUrl: string,
  resolver: HostResolver = defaultResolver
): Promise<SsrfCheckResult> {
  const result = await resolveScanUrlSafe(rawUrl, resolver)
  return result.safe ? { safe: true } : result
}

/** Resolve and validate a URL, retaining the approved addresses for connection pinning. */
export async function resolveScanUrlSafe(
  rawUrl: string,
  resolver: HostResolver = defaultResolver
): Promise<SafeResolutionResult> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { safe: false, reason: "invalid_url" }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: "invalid_scheme" }
  }

  const host = url.hostname.toLowerCase()
  if (!host) return { safe: false, reason: "empty_host" }

  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (bare.endsWith(".")) return { safe: false, reason: "trailing_dot" }
  if (BLOCKED_HOSTNAMES.has(bare) || bare.endsWith(".localhost")) {
    return { safe: false, reason: "blocked_hostname" }
  }

  const literal = parseIpLiteral(host)
  if (literal !== null) {
    return isBlockedIp(literal)
      ? { safe: false, reason: "blocked_ip" }
      : { safe: true, addresses: [literal] }
  }

  let addresses: string[]
  try {
    addresses = await resolver(bare)
  } catch {
    return { safe: false, reason: "dns_resolution_failed" }
  }
  if (!addresses || addresses.length === 0) {
    return { safe: false, reason: "dns_resolution_failed" }
  }
  const canonicalAddresses: string[] = []
  for (const addr of addresses) {
    const canon = parseIpLiteral(addr)
    if (canon === null) return { safe: false, reason: "dns_resolution_failed" }
    if (isBlockedIp(canon)) return { safe: false, reason: "resolves_to_blocked_ip" }
    canonicalAddresses.push(canon)
  }
  return { safe: true, addresses: canonicalAddresses }
}
