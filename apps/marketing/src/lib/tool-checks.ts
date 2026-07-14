export const LAUNCH_CHECKLIST_VERSION = "vibe-launch-checklist/1.1.0"

export const LAUNCH_CHECKS = [
  "Server-side authorization protects every sensitive action",
  "Tenant access and database policies are tested with two accounts",
  "Secrets are absent from commits, browser bundles, and AI context",
  "Input and model output are validated at every server boundary",
  "Login, reset, upload, webhook, and AI endpoints have rate limits",
  "Dependencies, lockfiles, and install scripts were independently reviewed",
  "Public routes, previews, databases, and storage buckets were inventoried",
  "Agents and MCP tools use least privilege, approvals, and sandbox boundaries",
  "Logs, traces, analytics, and eval data exclude secrets and sensitive prompts",
  "Security-critical tests include abuse cases the coding agent did not author",
  "Backups, monitoring, alerts, and an incident owner are documented",
] as const

interface SecretPattern {
  kind: string
  pattern: RegExp
  valueGroup?: number
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "OpenAI-compatible secret", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "GitHub token",
    pattern: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  { kind: "Stripe secret", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "Supabase secret", pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}\b/g },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "Private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    kind: "Assigned credential",
    pattern:
      /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{16,})/gi,
    valueGroup: 1,
  },
]

export interface SecretObservation {
  kind: string
  preview: string
}

function redact(value: string): string {
  if (value.includes("PRIVATE KEY")) return "private key block"
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export function scanTextForSecrets(text: string): SecretObservation[] {
  const observations: SecretObservation[] = []
  const seen = new Set<string>()

  for (const { kind, pattern, valueGroup = 0 } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[valueGroup]
      if (!value) continue
      const key = `${kind}:${value}`
      if (seen.has(key)) continue
      seen.add(key)
      observations.push({ kind, preview: redact(value) })
    }
  }

  return observations
}

function stripSqlCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .toLowerCase()
}

export function checkRlsSql(sql: string): string[] {
  if (!sql.trim()) return ["Paste policy SQL to review."]
  const normalized = stripSqlCommentsAndStrings(sql)
  const items: string[] = []

  if (!/enable\s+row\s+level\s+security/.test(normalized)) {
    items.push("No ENABLE ROW LEVEL SECURITY statement found outside comments or strings.")
  }
  if (!/force\s+row\s+level\s+security/.test(normalized)) {
    items.push(
      "No FORCE ROW LEVEL SECURITY statement found; verify whether table-owner bypass is acceptable."
    )
  }
  if (/(?:using|with\s+check)\s*\(\s*true\s*\)/.test(normalized)) {
    items.push("A policy appears to allow every row with USING (true) or WITH CHECK (true).")
  }
  if (/security\s+definer/.test(normalized)) {
    items.push("SECURITY DEFINER needs an explicit search_path and authorization review.")
  }
  if (/\bservice_role\b/.test(normalized)) {
    items.push("A service_role reference bypasses RLS; keep it in trusted server-only code.")
  }
  if (
    !/(auth\.uid\(\)|auth\.jwt\(\)|organization_id|workspace_id|tenant_id|user_id)/.test(normalized)
  ) {
    items.push(
      "No obvious ownership or tenant predicate was found; verify behavior with two accounts."
    )
  }

  return items.length
    ? items
    : ["No simple risky pattern found. Confirm behavior with a real two-account test."]
}

function parseHeaders(raw: string): Map<string, string[]> {
  const headers = new Map<string, string[]>()
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (!/^[a-z0-9-]+$/.test(name)) continue
    headers.set(name, [...(headers.get(name) ?? []), value])
  }
  return headers
}

export function checkHeaders(raw: string): string[] {
  const headers = parseHeaders(raw)
  if (!headers.size) return ["Paste response headers in name: value format."]
  const items: string[] = []

  for (const [header, message] of [
    ["content-security-policy", "Missing Content-Security-Policy."],
    ["strict-transport-security", "Missing Strict-Transport-Security."],
    ["x-content-type-options", "Missing X-Content-Type-Options."],
    ["referrer-policy", "Missing Referrer-Policy."],
    ["permissions-policy", "Missing Permissions-Policy."],
  ] as const) {
    if (!headers.has(header)) items.push(message)
  }

  const csp = headers.get("content-security-policy")?.join(";") ?? ""
  if (!headers.has("x-frame-options") && !/frame-ancestors/i.test(csp)) {
    items.push("No X-Frame-Options or CSP frame-ancestors protection found.")
  }

  const origins = headers.get("access-control-allow-origin") ?? []
  const credentials = headers.get("access-control-allow-credentials") ?? []
  if (origins.some((value) => value === "*")) {
    items.push(
      credentials.some((value) => value.toLowerCase() === "true")
        ? "CORS combines a wildcard origin with credentials; replace it with an explicit allowlist."
        : "CORS allows every origin; confirm the response is intentionally public."
    )
  }

  for (const cookie of headers.get("set-cookie") ?? []) {
    if (!/;\s*secure(?:;|$)/i.test(cookie)) items.push("A Set-Cookie value is missing Secure.")
    if (!/;\s*httponly(?:;|$)/i.test(cookie)) items.push("A Set-Cookie value is missing HttpOnly.")
    if (!/;\s*samesite=(?:lax|strict|none)(?:;|$)/i.test(cookie)) {
      items.push("A Set-Cookie value is missing an explicit SameSite policy.")
    }
  }

  return items.length
    ? [...new Set(items)]
    : ["No common header omission found. Review values and route-specific behavior too."]
}

function decodeBase64UrlJson(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("JWT segments must use Base64URL characters.")
  const base64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=")
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT header and claims must be JSON objects.")
  }
  return parsed as Record<string, unknown>
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : undefined
}

export function inspectJwt(token: string, now = Date.now()): string[] {
  const parts = token.trim().split(".")
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("A signed JWT needs three non-empty header.payload.signature segments.")
  }

  const header = decodeBase64UrlJson(parts[0])
  const claims = decodeBase64UrlJson(parts[1])
  const algorithm = typeof header.alg === "string" ? header.alg : "missing"
  const issuer = typeof claims.iss === "string" ? claims.iss : "missing"
  const audience = Array.isArray(claims.aud)
    ? claims.aud.filter((item): item is string => typeof item === "string").join(", ") || "missing"
    : typeof claims.aud === "string"
      ? claims.aud
      : "missing"
  const expiry = timestamp(claims.exp)
  const notBefore = timestamp(claims.nbf)
  const items = [
    `Algorithm: ${algorithm}.`,
    `Issuer: ${issuer}; audience: ${audience}.`,
    `Expiry: ${expiry ? new Date(expiry).toISOString() : "missing"}.`,
  ]

  if (algorithm.toLowerCase() === "none") items.push("Unsafe: alg=none must never be accepted.")
  if (expiry && expiry < now) items.push("This token is expired.")
  if (notBefore && notBefore > now) items.push("This token is not valid yet.")
  if (!expiry) items.push("No exp claim is present; define a bounded session lifetime.")

  return items
}

export function checkSetCookie(raw: string): string[] {
  const cookies = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^set-cookie\s*:/i, "").trim())
    .filter(Boolean)
  const items: string[] = []

  for (const cookie of cookies) {
    if (!/;\s*secure(?:;|$)/i.test(cookie)) items.push("A session cookie is missing Secure.")
    if (!/;\s*httponly(?:;|$)/i.test(cookie)) items.push("A session cookie is missing HttpOnly.")
    if (!/;\s*samesite=(?:lax|strict|none)(?:;|$)/i.test(cookie)) {
      items.push("A session cookie is missing an explicit SameSite policy.")
    }
  }

  return [...new Set(items)]
}
