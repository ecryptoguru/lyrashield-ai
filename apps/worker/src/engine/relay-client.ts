// security-scan-skip-file: grant minting + relay admin calls; scope decisions are the point
import { parse as parseYaml } from "yaml"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import {
  mintRelayGrant,
  normalizeRelayHost,
  redactUrlForLogs,
  safeFetchDetailed,
  createEgressProxyFetchFn,
  type RelayGrantScope,
} from "@lyrashield/security"

/**
 * Worker-side client for the scan-scoped target relay.
 *
 * The relay (inside the egress-proxy deployment) is the only path by which the
 * engine sandbox can reach a verified URL/API target. This module mints the
 * per-scan grant, fetches the body-free audit log for evidence, and revokes the
 * grant on any terminal scan state.
 */

export interface RelayRuntimeConfig {
  url: string
  signingSecret: string
  /** Admin secret shared with the egress proxy's audit/revoke endpoints. */
  adminSecret: string
}

export function resolveRelayRuntimeConfig(
  runtimeEnv: NodeJS.ProcessEnv = process.env
): RelayRuntimeConfig | null {
  const url = (runtimeEnv.LYRASHIELD_TARGET_RELAY_URL ?? "").trim()
  const signingSecret = (runtimeEnv.LYRASHIELD_RELAY_SIGNING_SECRET ?? "").trim()
  const adminSecret = (runtimeEnv.LYRASHIELD_EGRESS_PROXY_SECRET ?? "").trim()
  if (!url || !signingSecret || !adminSecret) return null
  return { url: url.replace(/\/+$/, ""), signingSecret, adminSecret }
}

const RELAY_LIMITS = {
  STANDARD: {
    maxRequests: 800,
    maxBytes: 40 * 1024 * 1024,
    ratePerMinute: 120,
    perPathPerMinute: 30,
  },
  DEEP: {
    maxRequests: 2_500,
    maxBytes: 80 * 1024 * 1024,
    ratePerMinute: 240,
    perPathPerMinute: 60,
  },
} as const

const GRANT_GRACE_MS = 5 * 60 * 1000
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS", "POST"]
const DESTRUCTIVE_METHODS = ["PUT", "PATCH", "DELETE"]

export interface MintRelayGrantInput {
  scanId: string
  /** Review depth — selects the relay rate/byte/request cap profile. */
  mode: "STANDARD" | "DEEP"
  /** DNS-verified apex domain (authorizes it + subdomains). */
  verifiedDomain: string
  /** Target URL; its host is scoped only when inside the verified apex. */
  targetUrl: string
  apiSpecUrl?: string | null
  /** Hosts extracted from the spec's servers[] (spec-declared base URLs are in scope). */
  specServerHosts?: string[]
  /** Engine wall-clock budget — the grant expires with the scan plus grace. */
  engineBudgetMs: number
  destructiveTestsAllowed?: boolean
  blockedPaths?: string[]
  /** Policy allowlist narrows (never widens) the computed host scope. */
  allowedDomains?: string[]
}

export function mintScanRelayGrant(
  input: MintRelayGrantInput,
  config: RelayRuntimeConfig
): { grant: string; scope: RelayGrantScope } {
  const limits = RELAY_LIMITS[input.mode]

  const hosts = new Set<string>()
  const addHost = (raw: string | null | undefined) => {
    const normalized = raw ? normalizeRelayHost(raw) : null
    if (normalized) hosts.add(normalized)
  }
  addHost(input.verifiedDomain)
  const apex = normalizeRelayHost(input.verifiedDomain)
  // DNS verification proves control of the apex only — a target URL or spec
  // that references an unrelated domain must not enlarge the relay's scope.
  const withinApex = (host: string | null) =>
    host !== null && apex !== null && (host === apex || host.endsWith(`.${apex}`))
  try {
    const targetHost = normalizeRelayHost(new URL(input.targetUrl).hostname)
    if (withinApex(targetHost)) hosts.add(targetHost as string)
  } catch {
    /* target URL validity is checked upstream */
  }
  try {
    if (input.apiSpecUrl) {
      const specHost = normalizeRelayHost(new URL(input.apiSpecUrl).hostname)
      if (withinApex(specHost)) hosts.add(specHost as string)
    }
  } catch {
    /* spec URL validity is checked upstream */
  }
  for (const host of input.specServerHosts ?? []) {
    const normalized = normalizeRelayHost(host)
    if (withinApex(normalized)) hosts.add(normalized as string)
  }

  let scopedHosts = [...hosts]
  const allowlist = (input.allowedDomains ?? [])
    .map((d) => normalizeRelayHost(d))
    .filter((d): d is string => Boolean(d))
  if (allowlist.length > 0) {
    scopedHosts = scopedHosts.filter((host) =>
      allowlist.some((d) => host === d || host.endsWith(`.${d}`))
    )
  }
  if (scopedHosts.length === 0) {
    throw new Error("RELAY_SCOPE_EMPTY")
  }

  const scope: RelayGrantScope = {
    v: 1,
    scanId: input.scanId,
    hosts: scopedHosts,
    methods: input.destructiveTestsAllowed
      ? [...SAFE_METHODS, ...DESTRUCTIVE_METHODS]
      : SAFE_METHODS,
    blockedPaths: input.blockedPaths ?? [],
    exp: Date.now() + input.engineBudgetMs + GRANT_GRACE_MS,
    ...limits,
  }
  return { grant: mintRelayGrant(scope, config.signingSecret), scope }
}

/** Extract in-scope server hosts from an OpenAPI document (JSON or YAML). */
export async function resolveSpecServerHosts(apiSpecUrl: string): Promise<string[]> {
  const fetchFn =
    env.LYRASHIELD_EGRESS_PROXY_URL && env.LYRASHIELD_EGRESS_PROXY_SECRET
      ? createEgressProxyFetchFn({
          url: env.LYRASHIELD_EGRESS_PROXY_URL,
          secret: env.LYRASHIELD_EGRESS_PROXY_SECRET,
          connectTimeoutMs: env.LYRASHIELD_EGRESS_PROXY_CONNECT_TIMEOUT_MS,
          readTimeoutMs: env.LYRASHIELD_EGRESS_PROXY_READ_TIMEOUT_MS,
        })
      : undefined
  const outcome = await safeFetchDetailed(apiSpecUrl, {
    maxBytes: 2 * 1024 * 1024,
    fetchFn,
  })
  if (!outcome.ok) {
    logger.warn("Could not fetch API spec for relay scope", {
      url: redactUrlForLogs(apiSpecUrl),
      reason: outcome.reason,
    })
    return []
  }
  try {
    const spec = (
      outcome.result.html.trimStart().startsWith("{")
        ? JSON.parse(outcome.result.html)
        : parseYaml(outcome.result.html)
    ) as { servers?: Array<{ url?: string }> }
    const hosts = new Set<string>()
    for (const server of spec.servers ?? []) {
      if (!server.url) continue
      try {
        const absolute = /^https?:\/\//.test(server.url)
          ? server.url
          : new URL(server.url, apiSpecUrl).toString()
        const host = normalizeRelayHost(new URL(absolute).hostname)
        if (host) hosts.add(host)
      } catch {
        /* skip unparseable server entries */
      }
    }
    return [...hosts]
  } catch {
    return []
  }
}

export interface RelayAuditEntry {
  ts: number
  type: "request" | "tunnel" | "denied"
  method?: string
  host: string
  port?: number
  path?: string
  status?: number
  bytes?: number
  durationMs?: number
  denyReason?: string
}

export async function fetchRelayAudit(
  scanId: string,
  config: RelayRuntimeConfig
): Promise<RelayAuditEntry[]> {
  try {
    const res = await fetch(`${config.url}/v1/audit/${encodeURIComponent(scanId)}`, {
      headers: { Authorization: `Bearer ${config.adminSecret}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { entries?: RelayAuditEntry[] }
    return Array.isArray(body.entries) ? body.entries : []
  } catch (err) {
    logger.warn("Relay audit fetch failed", {
      scanId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/** Admit this exact grant once, before execution. Never retry after relay restart. */
export async function registerRelayGrant(
  scanId: string,
  grant: string,
  config: RelayRuntimeConfig
): Promise<void> {
  const response = await fetch(`${config.url}/v1/register/${encodeURIComponent(scanId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.adminSecret}`, "x-lyra-relay-grant": grant },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  })
  if (!response.ok) throw new Error("RELAY_REGISTRATION_FAILED")
  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
    throw new Error("RELAY_REGISTRATION_FAILED")
  }
}

/** Revoke the grant immediately — call on every terminal scan state. */
export async function revokeRelayGrant(scanId: string, config: RelayRuntimeConfig): Promise<void> {
  try {
    await fetch(`${config.url}/v1/revoke/${encodeURIComponent(scanId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.adminSecret}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    logger.warn("Relay grant revocation failed", {
      scanId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
