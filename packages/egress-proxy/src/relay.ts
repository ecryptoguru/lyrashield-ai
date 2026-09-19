// security-scan-skip-file: scoped forward proxy; detection-style patterns are intentional
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { isIP, type LookupFunction } from "node:net"
import dns from "node:dns/promises"
import { Agent, request as undiciRequest } from "undici"
import { logger } from "@lyrashield/logger"
import {
  isBlockedIp,
  MAX_RELAY_GRANT_TTL_MS,
  normalizeRelayHost,
  normalizeRelayPath,
  redactUrlForLogs,
  relayHostAllowed,
  relayMethodAllowed,
  relayPathAllowed,
  relaySessionHostAllowed,
  validateRelaySessionBinding,
  verifyRelayGrant,
  type RelayGrantScope,
  type RelaySessionBinding,
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
 * Absolute-form HTTP and HTTPS requests are inspected before forwarding.
 * Opaque CONNECT tunnels cannot enforce method/path scope and are denied.
 */

const MAX_AUDIT_ENTRIES_PER_SCAN = 5_000
const MAX_RELAY_REQUEST_BODY = 2 * 1024 * 1024
const MAX_RELAY_RESPONSE_BODY = 10 * 1024 * 1024
const FORWARD_TIMEOUT_MS = 30_000
const ALLOWED_FORWARD_PORTS = new Set([80, 443])

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
  grant: string
  /**
   * Optional authenticated-session binding registered over the admin channel
   * alongside the grant. Values are injected into forwarded requests at this
   * boundary only — they are never logged, audited, or visible to the client.
   */
  session?: RelaySessionBinding
  active: Set<AbortController>
  requestCount: number
  bytesTotal: number
  rate: RateWindow
  perPath: Map<string, RateWindow>
  audit: RelayAuditEntry[]
}

export interface RelayHandler {
  /**
   * Admin-only admission; bearer requests never create or reset scan state.
   * `session` is the optional authenticated-beta binding — validated against
   * the grant scope before the state is admitted.
   */
  register(
    scanId: string,
    grant: string | undefined,
    session?: unknown
  ): { ok: true } | { ok: false; reason: string }
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
  allowedForwardPorts?: Set<number>
  /** Test-only trust root for a local HTTPS fixture. */
  ca?: string
}

export function createRelayHandler(signingSecret: string, deps?: RelayDeps): RelayHandler {
  const resolveHost = deps?.resolveHost ?? resolveScopedHost
  const allowedPorts = deps?.allowedForwardPorts ?? ALLOWED_FORWARD_PORTS
  const states = new Map<string, ScanRelayState>()
  const revoked = new Map<string, number>()
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
  }

  /** Grant validity + revocation + expiry + caps. Returns state or writes denial. */
  const authorize = (
    req: IncomingMessage,
    scanIdHint: string | null
  ): { state: ScanRelayState; scope: RelayGrantScope } | { deny: string } => {
    const grant = extractGrantToken(req.headers)
    const verified = verifyRelayGrant(grant, signingSecret)
    if (!verified.ok) return { deny: verified.reason }
    const { scope } = verified
    if (scanIdHint && scope.scanId !== scanIdHint) return { deny: "bad_signature" }
    if (revoked.has(scope.scanId)) return { deny: "revoked" }

    const state = states.get(scope.scanId)
    if (!state) return { deny: "unregistered_grant" }
    if (state.grant !== grant) return { deny: "scope_changed" }
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
    const controller = new AbortController()
    state.active.add(controller)
    const deadline = setTimeout(
      () => controller.abort(),
      Math.min(FORWARD_TIMEOUT_MS, scope.exp - Date.now())
    )
    const abortClient = () => {
      req.destroy()
      res.destroy()
    }
    controller.signal.addEventListener("abort", abortClient, { once: true })
    const clientClosed = () => {
      if (!res.writableFinished) controller.abort()
    }
    res.once("close", clientClosed)
    try {
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
      // Audit entries record the path only — query strings can carry tokens
      // (e.g. /login?token=…), matching redactUrlForLogs semantics.
      const auditPath = url.pathname
      const method = (req.method ?? "GET").toUpperCase()

      if (
        !allowedPorts.has(Number(url.port || (url.protocol === "https:" ? 443 : 80))) ||
        url.username ||
        url.password
      ) {
        denyForward(res, state, scope.scanId, "port_not_allowed", host, method, auditPath)
        return
      }
      if (!relayHostAllowed(scope, host)) {
        denyForward(res, state, scope.scanId, "host_out_of_scope", host, method, auditPath)
        return
      }
      if (!relayMethodAllowed(scope, method)) {
        denyForward(res, state, scope.scanId, "method_not_allowed", host, method, auditPath)
        return
      }
      if (!relayPathAllowed(scope, path)) {
        denyForward(res, state, scope.scanId, "path_blocked", host, method, auditPath)
        return
      }
      const pathPrefix = `/${normalizeRelayPath(url.pathname)!.split("/")[1] ?? ""}`
      const limit = checkLimits(state, pathPrefix)
      if (limit) {
        denyForward(res, state, scope.scanId, limit.deny, host, method, auditPath)
        return
      }

      const resolved = await resolveHost(host)
      controller.signal.throwIfAborted()
      if (!resolved.ok) {
        denyForward(res, state, scope.scanId, "host_out_of_scope", host, method, auditPath)
        return
      }

      // Authenticated-beta session binding: an expired session is a bounded
      // stop — the request is denied rather than silently forwarded without
      // the authenticated context the scan was authorized to exercise.
      if (state.session && state.session.exp <= Date.now()) {
        denyForward(res, state, scope.scanId, "session_expired", host, method, auditPath)
        return
      }

      let body: Buffer | undefined
      if (method !== "GET" && method !== "HEAD") {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).byteLength
          if (
            size > MAX_RELAY_REQUEST_BODY ||
            state.bytesTotal + (chunk as Buffer).byteLength > scope.maxBytes
          ) {
            denyForward(res, state, scope.scanId, "byte_cap", host, method, auditPath)
            return
          }
          state.bytesTotal += (chunk as Buffer).byteLength
          chunks.push(chunk as Buffer)
        }
        body = Buffer.concat(chunks)
      }

      const connectionHeaders = new Set(
        (req.headers.connection ?? "")
          .toLowerCase()
          .split(",")
          .map((header) => header.trim())
      )
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP_HEADERS.has(key) || connectionHeaders.has(key) || value === undefined)
          continue
        headers[key] = Array.isArray(value) ? value.join(", ") : value
      }

      // Session headers apply only to hosts the binding authorizes, and
      // override any client-supplied values for those names — the sandboxed
      // engine must never originate credential material itself.
      if (state.session && relaySessionHostAllowed(state.session, host)) {
        for (const [name, value] of Object.entries(state.session.headers)) {
          headers[name] = value
        }
      }

      // The grant may narrow the global response ceiling (authenticated beta).
      const maxResponseBytes = Math.min(
        MAX_RELAY_RESPONSE_BODY,
        scope.maxResponseBytes ?? MAX_RELAY_RESPONSE_BODY
      )

      let bytes = 0
      const dispatcher = new Agent({
        connect: { lookup: pinnedLookup(resolved.addresses), ...(deps?.ca ? { ca: deps.ca } : {}) },
      })
      try {
        const upstream = await undiciRequest(url.toString(), {
          method: method as "GET",
          headers,
          body,
          dispatcher,
          signal: controller.signal,
          headersTimeout: 10_000,
          bodyTimeout: FORWARD_TIMEOUT_MS,
        })
        // A declared body that can never fit the caps is denied outright —
        // silently truncating would hand the client an indistinguishable prefix.
        const declaredLength = Number(upstream.headers["content-length"] ?? 0)
        if (
          declaredLength > maxResponseBytes ||
          declaredLength > scope.maxBytes - state.bytesTotal
        ) {
          upstream.body.destroy()
          denyForward(res, state, scope.scanId, "byte_cap", host, method, auditPath)
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
        let truncated = false
        for await (const chunk of upstream.body) {
          const size = (chunk as Buffer).byteLength
          if (bytes + size > maxResponseBytes || state.bytesTotal + size > scope.maxBytes) {
            truncated = true
            break
          }
          bytes += size
          state.bytesTotal += size
          res.write(chunk)
        }
        if (truncated) {
          upstream.body.destroy()
          res.destroy()
        } else res.end()
        record(state, scope.scanId, {
          ts: started,
          type: "request",
          method,
          host,
          path: auditPath,
          status: upstream.statusCode,
          bytes,
          truncated: truncated || undefined,
          durationMs: Date.now() - started,
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        logger.warn("Relay forward failed", {
          url: redactUrlForLogs(url.toString()),
          error: detail,
        })
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: false, reason: "upstream_failed" }))
        } else res.destroy()
        record(state, scope.scanId, {
          ts: started,
          type: "request",
          method,
          host,
          path: auditPath,
          durationMs: Date.now() - started,
          bytes,
          truncated: bytes > 0 || undefined,
          denyReason: controller.signal.aborted ? "aborted" : "upstream_failed",
        })
      } finally {
        void dispatcher.destroy()
      }
    } finally {
      clearTimeout(deadline)
      state.active.delete(controller)
      controller.signal.removeEventListener("abort", abortClient)
      res.removeListener("close", clientClosed)
    }
  }

  function handleConnect(req: IncomingMessage, clientSocket: Duplex, _head: Buffer): void {
    const auth = authorize(req, null)
    const state = "deny" in auth ? null : auth.state
    const reason = "deny" in auth ? auth.deny : "connect_not_supported"
    record(state, state?.scope.scanId ?? "unscoped", {
      ts: Date.now(),
      type: "denied",
      host: req.url ?? "",
      method: "CONNECT",
      denyReason: reason,
    })
    clientSocket.end(`HTTP/1.1 403 ${reason}\r\nConnection: close\r\n\r\n`)
  }

  // Sweep dead scan states so grants can't outlive their scan in memory.
  // The audit trail outlives the state: the worker fetches it after terminal
  // transitions, which happen after revocation or expiry.
  const sweep = () => {
    const now = Date.now()
    for (const [scanId, state] of states) {
      if (state.scope.exp <= now || revoked.has(scanId)) {
        states.delete(scanId)
        for (const controller of state.active) controller.abort()
        // Keep the shared array even if an aborted in-flight request has not
        // appended its terminal audit entry yet.
        closedAudits.set(scanId, { entries: state.audit, expiresAt: now + CLOSED_AUDIT_TTL_MS })
      }
    }
    for (const [scanId, expiry] of revoked) {
      if (expiry <= now) revoked.delete(scanId)
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
    register(scanId, grant, session) {
      const verified = verifyRelayGrant(grant, signingSecret)
      if (!verified.ok) return verified
      const { scope } = verified
      if (scope.scanId !== scanId) return { ok: false, reason: "scope_mismatch" }
      if (revoked.has(scanId)) return { ok: false, reason: "revoked" }
      // The session binding may only narrow the grant — an out-of-scope or
      // malformed binding fails registration closed; it is never relaxed.
      let binding: RelaySessionBinding | undefined
      if (session !== undefined) {
        const validated = validateRelaySessionBinding(scope, session)
        if (!validated.ok) return { ok: false, reason: validated.reason }
        binding = validated.session
      }
      const existing = states.get(scanId)
      if (existing) {
        const sameGrant = existing.grant === grant
        const sameSession =
          JSON.stringify(existing.session ?? null) === JSON.stringify(binding ?? null)
        return sameGrant && sameSession ? { ok: true } : { ok: false, reason: "scope_changed" }
      }
      if (closedAudits.has(scanId)) return { ok: false, reason: "closed_scan" }
      states.set(scanId, {
        scope,
        grant: grant!,
        ...(binding ? { session: binding } : {}),
        active: new Set(),
        requestCount: 0,
        bytesTotal: 0,
        rate: { windowStart: Date.now(), count: 0 },
        perPath: new Map(),
        audit: [],
      })
      return { ok: true }
    },
    handleForward,
    handleConnect,
    revoke(scanId: string) {
      revoked.set(scanId, Date.now() + MAX_RELAY_GRANT_TTL_MS)
      const state = states.get(scanId)
      if (state) for (const controller of state.active) controller.abort()
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
