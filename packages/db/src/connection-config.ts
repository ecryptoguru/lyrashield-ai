import type { ClientConfig } from "pg"
import { domainToASCII } from "node:url"
import { getCACertificates } from "node:tls"
import { SUPABASE_ROOT_CA } from "./supabase-ca"
import { parse } from "pg-connection-string"

const QUERY_KEYS = new Set([
  "schema",
  "sslmode",
  "uselibpqcompat",
  "application_name",
  "pgbouncer",
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
])
const SUPABASE_POOLER_HOST = /(?:^|\.)pooler\.supabase\.com$/
const SUPABASE_DIRECT_HOST = /^db\.[a-z0-9]{20}\.supabase\.co$/

function isSupabaseHostname(value: string): boolean {
  let hostname: string
  try {
    hostname = decodeURIComponent(value).toLowerCase().replace(/\.$/, "")
  } catch {
    return /supabase/i.test(value)
  }
  const asciiHostname = domainToASCII(hostname).toLowerCase().replace(/\.$/, "")
  return SUPABASE_POOLER_HOST.test(asciiHostname) || SUPABASE_DIRECT_HOST.test(asciiHostname)
}

function hasSupabaseQueryHostParameters(searchParams: URLSearchParams): boolean {
  return searchParams
    .getAll("host")
    .some((candidate) => candidate.split(",").some((item) => isSupabaseHostname(item.trim())))
}

function hasSupabaseQueryHost(connectionString: string): boolean {
  const normalized = connectionString.replace(/[\t\n\r]/g, "")
  return [connectionString, normalized].some((value) => {
    const queryStart = value.indexOf("?")
    if (queryStart < 0) return false
    const query = value.slice(queryStart + 1).split("#", 1)[0]
    return hasSupabaseQueryHostParameters(new URLSearchParams(query))
  })
}

function invalidConnection(): never {
  // Parser errors can include URLs or credentials. Emit only this fixed message.
  throw new Error("Invalid Supabase database connection configuration")
}

/**
 * Keep receipt-bound URLs unchanged, but enforce verified TLS for Supabase.
 * pg reparses connectionString over sibling options, so a separate ssl option
 * cannot safely override legacy uselibpqcompat=true&sslmode=require. Validate
 * the target, then pass discrete fields with no connectionString to reparse.
 */
export function createPgConnectionConfig(connectionString: string | undefined): ClientConfig {
  if (connectionString === undefined) return { connectionString }
  const querySupabase = hasSupabaseQueryHost(connectionString)
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    if (/supabase/i.test(connectionString) || querySupabase) invalidConnection()
    return { connectionString }
  }
  const normalizedQuerySupabase = hasSupabaseQueryHostParameters(url.searchParams)
  const supabaseQueryHost = querySupabase || normalizedQuerySupabase
  let host: string
  try {
    // pg-connection-string decodes escaped hostnames before connecting. Match
    // against that effective host so an encoded Supabase suffix cannot skip
    // verified TLS and then become a Supabase target in pg.
    host = decodeURIComponent(url.hostname).toLowerCase()
  } catch {
    if (/supabase/i.test(url.hostname) || supabaseQueryHost) invalidConnection()
    return { connectionString }
  }
  const canonicalHost = host.replace(/\.$/, "")
  const supabase = isSupabaseHostname(host) || supabaseQueryHost
  if (!supabase) return { connectionString }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") invalidConnection()
  const port = Number(url.port || 5432)
  if (
    connectionString.length > 8192 ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    host !== url.hostname.toLowerCase() ||
    host !== canonicalHost ||
    url.hash ||
    !url.username ||
    !url.password ||
    !url.pathname.slice(1) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    invalidConnection()
  const seen = new Set<string>()
  for (const key of url.searchParams.keys()) {
    if (!QUERY_KEYS.has(key) || seen.has(key)) invalidConnection()
    seen.add(key)
  }
  if (!new Set(["require", "verify-full"]).has(url.searchParams.get("sslmode") ?? "")) {
    invalidConnection()
  }
  if (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public") {
    invalidConnection()
  }
  if (
    url.searchParams.has("uselibpqcompat") &&
    !new Set(["true", "false", "1", "0"]).has(url.searchParams.get("uselibpqcompat") ?? "")
  ) {
    invalidConnection()
  }

  try {
    // The allowlist above prevents parser-triggered file reads and target overrides.
    // Normalize only the parser input's TLS policy; the caller's raw URL is retained.
    const verified = new URL(url)
    verified.searchParams.set("sslmode", "verify-full")
    verified.searchParams.delete("uselibpqcompat")
    const parsed = parse(verified.toString())
    const user = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    const database = decodeURIComponent(url.pathname.slice(1))
    if (
      parsed.host !== url.hostname ||
      parsed.user !== user ||
      parsed.password !== password ||
      parsed.database !== database ||
      parsed.port !== (url.port || "")
    )
      invalidConnection()
    return {
      host: parsed.host,
      port,
      user,
      password,
      database,
      ...(parsed.application_name ? { application_name: parsed.application_name } : {}),
      // Explicit ca replaces Node's default store; retain its public/system/extra
      // roots and append only the dashboard's pinned public Supabase root.
      // This trust applies only to this validated database target, never globally.
      ssl: { rejectUnauthorized: true, ca: [...getCACertificates("default"), SUPABASE_ROOT_CA] },
    }
  } catch {
    return invalidConnection()
  }
}
