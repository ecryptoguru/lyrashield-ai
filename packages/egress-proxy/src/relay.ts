// security-scan-skip-file: scoped forward proxy; detection-style patterns are intentional
import type { IncomingMessage, ServerResponse } from "node:http"
import net from "node:net"
import type { Duplex } from "node:stream"
import { isIP, type LookupFunction } from "node:net"
import dns from "node:dns/promises"
import { Agent, request as undiciRequest } from "undici"
import { logger } from "@lyrashield/logger"
import {
  isBlockedIp,
  normalizeRelayHost,
  redactUrlForLogs,
  relayHostAllowed,
  relayMethodAllowed,
  relayPathAllowed,
  verifyRelayGrant,
  type RelayGrantScope,
} from "@lyrashield/security"

/**
 * Scan-scoped forward relay.
 *
 * The engine sandbox has no route to arbitrary hosts. For verified URL targets
 * the worker mints an HMAC-signed grant; this relay enforces it at the network
 * boundary — host allowlist, method allowlist, path denials, per-scan and
 * per-path rate limits, byte caps, revocation — and records a bounded,
 * body-free audit trail per scan.
 *
 * Two traffic forms:
 *  - CONNECT host:port  → opaque TLS tunnel to a scoped host on 443/80 only
 *  - absolute-form HTTP → fully audited forward (method/path/status/bytes)
 */

const MAX_AUDIT_ENTRIES_PER_SCAN = 5_000
const MAX_RELAY_REQUEST_BODY = 2 * 1024 * 1024
const MAX_RELAY_RESPONSE_BODY = 10 * 1024 * 1024
const FORWARD_TIMEOUT_MS = 30_000
const TUNNEL_IDLE_TIMEOUT_MS = 120_000
const ALLOWED_CONNECT_PORTS = new Set([80, 443])

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-lyra-relay-grant",
])

export interface RelayAuditEntry {
  ts: number
  type: "request" | "tunnel" | "denied"
  method?: string
  host: string
  port?: number
  path?: string
  status?: number
  bytes?: number
  /** Response body cut short by the byte caps — the client received a prefix only. */
  truncated?: boolean
  durationMs?: number
  denyReason?: string
}

interface RateWindow {
  windowStart: number
  count: number
}

interface ScanRelayState {
  scope: RelayGrantScope
  requestCount: number
  bytesTotal: number
  rate: RateWindow
  perPath: Map<string, RateWindow>
  audit: RelayAuditEntry[]
}

export interface RelayHandler {
  handleForward(req: IncomingMessage, res: ServerResponse): Promise<void>
  handleConnect(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void
  revoke(scanId: string): void
  getAudit(scanId: string): RelayAuditEntry[] | null
  /** Test/diagnostic: number of live scan states. */
  stateCount(): number
  /** Test hook: run the expiry/revocation sweep synchronously. */
  _sweep(): void
}

function extractGrantToken(headers: IncomingMessage["headers"]): string | undefined {
  const direct = headers["x-lyra-relay-grant"]
  if (typeof direct === "string" && direct) return direct
  const proxyAuth = headers["proxy-authorization"]
  const value = Array.isArray(proxyAuth) ? proxyAuth[0] : proxyAuth
  if (typeof value !== "string") return undefined
  if (value.startsWith("Bearer ")) return value.slice(7).trim()
  // Standard tooling embeds the grant as proxy userinfo (http://<grant>@host or
  // http://x:<grant>@host) and sends Proxy-Authorization: Basic. Accept the
  // grant in either userinfo position.
  if (value.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(value.slice(6).trim(), "base64").toString("utf8")
      const [user, ...rest] = decoded.split(":")
      const pass = rest.join(":")
      if (user?.startsWith("lrg1.")) return user
      if (pass.startsWith("lrg1.")) return pass
    } catch {
      /* fall through */
    }
  }
  return undefined
}

function pinnedLookup(addresses: string[]): LookupFunction {
  const records = addresses.map((address) => ({ address, family: isIP(address) }))
  return (_hostname, options, callback) => {
    if (options.all) callback(null, records)
    else callback(null, records[0]?.address ?? "", records[0]?.family)
  }
}

async function resolveScopedHost(
  host: string
): Promise<{ ok: true; addresses: string[] } | { ok: false }> {
  const normalized = normalizeRelayHost(host)
  if (!normalized) return { ok: false }
  if (isIP(normalized) !== 0) {
    return isBlockedIp(normalized) ? { ok: false } : { ok: true, addresses: [normalized] }
  }
  const [v4, v6] = await Promise.allSettled([dns.resolve4(normalized), dns.resolve6(normalized)])
  const addresses = [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ]
  if (addresses.length === 0) return { ok: false }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) return { ok: false }
  }
  return { ok: true, addresses }
}

export interface RelayDeps {
  /** Test-only host resolver — production resolves scoped hosts with DNS + range checks. */
  resolveHost?: (host: string) => Promise<{ ok: true; addresses: string[] } | { ok: false }>
  /** Test-only port allowlist override — production is 80/443 only. */
  allowedConnectPorts?: Set<number>
}

export function createRelayHandler(signingSecret: string, deps?: RelayDeps): RelayHandler {
  const resolveHost = deps?.resolveHost ?? resolveScopedHost
  const allowedPorts = deps?.allowedConnectPorts ?? ALLOWED_CONNECT_PORTS
  const states = new Map<string, ScanRelayState>()
  const revoked = new Set<string>()
  // Grants are revoked/expired before the worker fetches the audit — swept
  // states must keep their trail for a bounded window or the evidence is lost.
  const closedAudits = new Map<string, { entries: RelayAuditEntry[]; expiresAt: number }>()
  const CLOSED_AUDIT_TTL_MS = 30 * 60 * 1000
  const MAX_CLOSED_AUDITS = 200

  // Denied requests with no valid grant have no scan context; keep a bounded
  // shared bucket so abuse attempts remain auditable.
  const unscopedAudit: RelayAuditEntry[] = []

  const record = (state: ScanRelayState | null, scanId: string, entry: RelayAuditEntry) => {
    const target = state ? state.audit : unscopedAudit
    if (target.length < MAX_AUDIT_ENTRIES_PER_SCAN) target.push(entry)
    if (state && entry.bytes) state.bytesTotal += entry.bytes
  }

  /** Grant validity + revocation + expiry + caps. Returns state or writes denial. */
  const authorize = (
    req: IncomingMessage,
    scanIdHint: string | null
  ): { state: ScanRelayState; scope: RelayGrantScope } | { deny: string } => {
    const verified = verifyRelayGrant(extractGrantToken(req.headers), signingSecret)
    if (!verified.ok) return { deny: verified.reason }
    const { scope } = verified
    if (scanIdHint && scope.scanId !== scanIdHint) return { deny: "bad_signature" }
    if (revoked.has(scope.scanId)) return { deny: "revoked" }

    let state = states.get(scope.scanId)
    if (!state) {
      state = {
        scope,
        requestCount: 0,
        bytesTotal: 0,
        rate: { windowStart: Date.now(), count: 0 },
        perPath: new Map(),
        audit: [],
      }
      states.set(scope.scanId, state)
    } else if (state.scope.exp !== scope.exp || state.scope.hosts.join() !== scope.hosts.join()) {
      // Re-minted grant for the same scan (e.g. extension): adopt the newer scope.
      state.scope = scope
    }
    return { state, scope }
  }

  const checkLimits = (
    state: ScanRelayState,
    pathPrefix: string | null
  ): { deny: string } | null => {
    const { scope } = state
    if (state.requestCount >= scope.maxRequests) return { deny: "request_cap" }
    if (state.bytesTotal >= scope.maxBytes) return { deny: "byte_cap" }

    const now = Date.now()
    if (now - state.rate.windowStart >= 60_000) {
      state.rate = { windowStart: now, count: 0 }
      state.perPath.clear()
    }
    if (state.rate.count >= scope.ratePerMinute) return { deny: "rate_limited" }

    if (pathPrefix) {
      const pathWindow = state.perPath.get(pathPrefix) ?? { windowStart: now, count: 0 }
      if (pathWindow.count >= scope.perPathPerMinute) return { deny: "rate_limited" }
      pathWindow.count += 1
      state.perPath.set(pathPrefix, pathWindow)
    }
    state.rate.count += 1
    state.requestCount += 1
    return null
  }

  const denyForward = (
    res: ServerResponse,
    state: ScanRelayState | null,
    scanId: string,
    reason: string,
    host = "",
    method?: string,
    path?: string
  ) => {
    record(state, scanId, {
      ts: Date.now(),
      type: "denied",
      denyReason: reason,
      host,
      method,
      path,
    })
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: false, reason }))
  }

  async function handleForward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const auth = authorize(req, null)
    if ("deny" in auth) {
      denyForward(res, null, "unknown", auth.deny)
      return
    }
    const { state, scope } = auth

    let url: URL
    try {
      const raw = req.url ?? ""
      url =
        raw.startsWith("http://") || raw.startsWith("https://")
          ? new URL(raw)
          : new URL(`http://${req.headers.host ?? ""}${raw}`)
    } catch {
      denyForward(res, state, scope.scanId, "malformed")
      return
    }
    const host = url.hostname
    const path = url.pathname + url.search
    const method = (req.method ?? "GET").toUpperCase()

    if (url.protocol === "https:") {
      denyForward(res, state, scope.scanId, "https_requires_connect", host, method, path)
      return
    }
    if (!relayHostAllowed(scope, host)) {
      denyForward(res, state, scope.scanId, "host_out_of_scope", host, method, path)
      return
    }
    if (!relayMethodAllowed(scope, method)) {
      denyForward(res, state, scope.scanId, "method_not_allowed", host, method, path)
      return
    }
    if (!relayPathAllowed(scope, path)) {
      denyForward(res, state, scope.scanId, "path_blocked", host, method, path)
      return
    }
    const pathPrefix = `/${url.pathname.split("/")[1] ?? ""}`
    const limit = checkLimits(state, pathPrefix)
    if (limit) {
      denyForward(res, state, scope.scanId, limit.deny, host, method, path)
      return
    }

    const resolved = await resolveHost(host)
    if (!resolved.ok) {
      denyForward(res, state, scope.scanId, "host_out_of_scope", host, method, path)
      return
    }

    let body: Buffer | undefined
    if (method !== "GET" && method !== "HEAD") {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength
        if (size > MAX_RELAY_REQUEST_BODY) {
          denyForward(res, state, scope.scanId, "byte_cap", host, method, path)
          return
        }
        chunks.push(chunk as Buffer)
      }
      body = Buffer.concat(chunks)
      state.bytesTotal += size
    }

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_HEADERS.has(key) || value === undefined) continue
      headers[key] = Array.isArray(value) ? value.join(", ") : value
    }
    for (const [key, value] of Object.entries(scope.injectHeaders ?? {})) {
      headers[key.toLowerCase()] = value
    }

    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(resolved.addresses) } })
    try {
      const upstream = await undiciRequest(url.toString(), {
        method: method as "GET",
        headers,
        body,
        dispatcher,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        headersTimeout: 10_000,
        bodyTimeout: FORWARD_TIMEOUT_MS,
      })
      // A declared body that can never fit the caps is denied outright —
      // silently truncating would hand the client an indistinguishable prefix.
      const declaredLength = Number(upstream.headers["content-length"] ?? 0)
      if (declaredLength > MAX_RELAY_RESPONSE_BODY || declaredLength > scope.maxBytes) {
        upstream.body.destroy()
        denyForward(res, state, scope.scanId, "byte_cap", host, method, path)
        return
      }
      // content-length is always stripped: truncation would otherwise send a
      // declared length that does not match the body we actually deliver.
      res.writeHead(
        upstream.statusCode,
        Object.fromEntries(
          Object.entries(upstream.headers).filter(
            ([k, v]) => v !== undefined && !HOP_BY_HOP_HEADERS.has(k) && k !== "content-length"
          )
        ) as never
      )
      let bytes = 0
      let truncated = false
      for await (const chunk of upstream.body) {
        bytes += (chunk as Buffer).byteLength
        if (bytes > MAX_RELAY_RESPONSE_BODY || state.bytesTotal + bytes > scope.maxBytes) {
          truncated = true
          break
        }
        res.write(chunk)
      }
      res.end()
      if (truncated) upstream.body.destroy()
      record(state, scope.scanId, {
        ts: started,
        type: "request",
        method,
        host,
        path,
        status: upstream.statusCode,
        bytes,
        truncated: truncated || undefined,
        durationMs: Date.now() - started,
      })
      if (state.bytesTotal >= scope.maxBytes) revoked.add(scope.scanId)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn("Relay forward failed", {
        url: redactUrlForLogs(url.toString()),
        error: detail,
      })
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: false, reason: "upstream_failed" }))
      record(state, scope.scanId, {
        ts: started,
        type: "request",
        method,
        host,
        path,
        durationMs: Date.now() - started,
        denyReason: "upstream_failed",
      })
    } finally {
      void dispatcher.destroy()
    }
  }

  function handleConnect(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const started = Date.now()
    const fail = (code: number, reason: string, state: ScanRelayState | null, host = "") => {
      record(state, state?.scope.scanId ?? "unscoped", {
        ts: Date.now(),
        type: "denied",
        denyReason: reason,
        host,
        port: 443,
      })
      clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`, () => clientSocket.destroy())
    }

    const auth = authorize(req, null)
    if ("deny" in auth) return fail(403, auth.deny, null)
    const { state, scope } = auth

    const authority = req.url ?? ""
    const sep = authority.lastIndexOf(":")
    const host = sep > 0 ? authority.slice(0, sep) : authority
    const port = sep > 0 ? Number(authority.slice(sep + 1)) : 0

    if (!allowedPorts.has(port) || !Number.isInteger(port)) {
      return fail(403, "method_not_allowed", state, host)
    }
    if (!relayHostAllowed(scope, host)) {
      return fail(403, "host_out_of_scope", state, host)
    }
    const limit = checkLimits(state, null)
    if (limit) return fail(403, limit.deny, state, host)

    void resolveHost(host).then((resolved) => {
      if (!resolved.ok) return fail(403, "host_out_of_scope", state, host)

      const upstream = net.connect({ host: resolved.addresses[0], port })
      let settled = false
      let bytes = 0
      const capReached = () =>
        bytes > MAX_RELAY_RESPONSE_BODY || state.bytesTotal + bytes > scope.maxBytes
      const onData = (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (capReached()) {
          upstream.destroy()
          clientSocket.destroy()
        }
      }
      upstream.once("connect", () => {
        settled = true
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head?.byteLength) upstream.write(head)
        // Byte caps bound the tunnel in BOTH directions — outbound data can
        // otherwise evade the per-scan budget entirely.
        clientSocket.on("data", onData)
        upstream.on("data", onData)
        upstream.pipe(clientSocket).pipe(upstream)
      })
      upstream.once("error", () => {
        if (!settled) fail(502, "upstream_failed", state, host)
        else clientSocket.destroy()
      })
      upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => {
        upstream.destroy()
        clientSocket.destroy()
      })
      const done = () => {
        record(state, scope.scanId, {
          ts: started,
          type: "tunnel",
          host,
          port,
          bytes,
          durationMs: Date.now() - started,
        })
      }
      clientSocket.once("close", done)
      upstream.once("close", () => {
        clientSocket.destroy()
      })
    })
  }

  // Sweep dead scan states so grants can't outlive their scan in memory.
  // The audit trail outlives the state: the worker fetches it after terminal
  // transitions, which happen after revocation or expiry.
  const sweep = () => {
    const now = Date.now()
    for (const [scanId, state] of states) {
      if (state.scope.exp <= now || revoked.has(scanId)) {
        states.delete(scanId)
        revoked.delete(scanId)
        if (state.audit.length > 0) {
          closedAudits.set(scanId, { entries: state.audit, expiresAt: now + CLOSED_AUDIT_TTL_MS })
        }
      }
    }
    for (const [scanId, closed] of closedAudits) {
      if (closed.expiresAt <= now) closedAudits.delete(scanId)
    }
    while (closedAudits.size > MAX_CLOSED_AUDITS) {
      const oldest = closedAudits.keys().next().value
      if (oldest === undefined) break
      closedAudits.delete(oldest)
    }
  }
  const sweeper = setInterval(sweep, 60_000)
  sweeper.unref()

  return {
    handleForward,
    handleConnect,
    revoke(scanId: string) {
      revoked.add(scanId)
      const state = states.get(scanId)
      if (state)
        record(state, scanId, { ts: Date.now(), type: "denied", denyReason: "revoked", host: "" })
    },
    getAudit(scanId: string) {
      if (scanId === "unscoped") return unscopedAudit
      return states.get(scanId)?.audit ?? closedAudits.get(scanId)?.entries ?? null
    },
    stateCount() {
      return states.size
    },
    /** Test hook: run the expiry/revocation sweep synchronously. */
    _sweep: sweep,
  }
}
