/* eslint-disable security/detect-unsafe-regex */
import { logger } from "@lyrashield/logger"
import {
  redactUrlForLogs,
  safeFetchDetailed,
  SAFE_FETCH_REASON_TEXT,
  type HostResolver,
} from "@lyrashield/security"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

export interface UrlScanConfig {
  targetUrl: string
  fetchFn?: typeof fetch
  /** Injectable DNS resolver — only for tests. */
  resolver?: HostResolver
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
}

function makeFinding(
  id: string,
  title: string,
  severity: string,
  cwe: string,
  description: string,
  remediation: string,
  extra?: Partial<EngineVulnerability>
): EngineVulnerability {
  return {
    id,
    title,
    severity,
    timestamp: new Date().toISOString(),
    cwe,
    description,
    remediation_steps: remediation,
    ...extra,
  }
}

/**
 * Fetch the target URL through the shared, hardened, fetch-time SSRF guard
 * (`@lyrashield/security` → `safeFetch`): the host is DNS-resolved and
 * range-checked on every hop, redirects are re-validated manually, alternate IP
 * encodings are canonicalized, and the body is size-bounded. This replaces the
 * previous weak inline `isPrivateIp` string check, which did no DNS resolution,
 * missed decimal/hex/octal IPv4 and many reserved ranges, and auto-followed
 * redirects.
 */
async function fetchUrl(
  url: string,
  fetchFn?: typeof fetch,
  resolver?: HostResolver,
  signal?: AbortSignal
): Promise<
  | {
      html: string
      status: number
      headers: Record<string, string>
      finalUrl: string
      urlHistory: string[]
    }
  | { failureReason: string }
> {
  const outcome = await safeFetchDetailed(url, { fetchFn, resolver, signal })
  if (!outcome.ok) return { failureReason: describeFetchFailure(outcome) }
  const { result } = outcome
  return {
    html: result.html,
    status: result.status,
    headers: result.headers,
    finalUrl: result.finalUrl,
    urlHistory: result.urlHistory,
  }
}

/**
 * Turn a typed fetch failure into a sentence an operator can act on. The
 * previous single "could not be fetched" line could not distinguish the guard
 * doing its job from the scanner having no egress at all.
 */
function describeFetchFailure(outcome: { reason: string; detail?: string }): string {
  const base = SAFE_FETCH_REASON_TEXT[outcome.reason as keyof typeof SAFE_FETCH_REASON_TEXT]
  const explanation = base ?? outcome.reason
  return outcome.detail ? `${explanation} (${outcome.detail})` : explanation
}

function detectSupabasePrivilegedKey(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const supabaseKeyPattern = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  const supabaseUrlPattern = /https:\/\/[a-z0-9]+\.supabase\.co/i
  const hasSupabaseUrl = supabaseUrlPattern.test(html)
  const legacyKeys = html.match(supabaseKeyPattern) ?? []
  const privilegedLegacyKeys = legacyKeys.filter((key) => {
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString())
      return payload?.role === "service_role"
    } catch {
      return false
    }
  })
  const secretKeys = html.match(/sb_secret_[A-Za-z0-9_-]{20,}/g) ?? []
  if (hasSupabaseUrl) {
    for (let i = 0; i < privilegedLegacyKeys.length + secretKeys.length; i++) {
      findings.push(
        makeFinding(
          `url-supabase-privileged-key-${i}`,
          "Exposed Supabase privileged key in client response",
          "CRITICAL",
          "CWE-798",
          "A Supabase secret or legacy service_role key is embedded in the public response. Unlike publishable and anon keys, privileged keys bypass Row Level Security and must remain server-side.",
          "Remove the privileged key from client code and built assets, rotate it in Supabase, and keep it only in a server-side secret store.",
          {
            technical_analysis:
              "The scanner decoded only the JWT role claim or matched Supabase's secret-key prefix; the key value is not retained.",
            control_ids: [3],
          }
        )
      )
    }
  }
  return findings
}

function detectExposedApiKeys(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const patterns = [
    { regex: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g, name: "stripe-secret-key" },
    { regex: /gh[pousr]_[A-Za-z0-9]{36}/g, name: "github-token" },
  ]
  for (const { regex, name } of patterns) {
    const matches = html.match(regex)
    if (matches) {
      for (let i = 0; i < matches.length; i++) {
        findings.push(
          makeFinding(
            `url-exposed-key-${name}-${i}`,
            `Exposed ${name.replace(/-/g, " ")} in client-side code`,
            "HIGH",
            "CWE-798",
            `A ${name.replace(/-/g, " ")} was found embedded in the page source. This key could be extracted by anyone visiting the site and used for unauthorized access.`,
            "1. Move the key to a server-side environment variable.\n2. Rotate the exposed key immediately.\n3. Use a backend proxy for API calls requiring the key.\n4. Implement rate limiting on the API to reduce impact if keys are leaked.",
            {
              poc_description: `Extract the key from the page source and use it directly against the corresponding service API.`,
              control_ids: [3],
            }
          )
        )
      }
    }
  }
  return findings
}

function detectMissingSecurityHeaders(headers: Record<string, string>): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const securityHeaders = [
    {
      header: "content-security-policy",
      title: "Missing Content-Security-Policy header",
      severity: "MEDIUM",
      cwe: "CWE-693",
    },
    {
      header: "strict-transport-security",
      title: "Missing Strict-Transport-Security header",
      severity: "MEDIUM",
      cwe: "CWE-319",
    },
    {
      header: "x-frame-options",
      title: "Missing X-Frame-Options header",
      severity: "LOW",
      cwe: "CWE-693",
    },
    {
      header: "x-content-type-options",
      title: "Missing X-Content-Type-Options header",
      severity: "LOW",
      cwe: "CWE-693",
    },
  ]
  for (const { header, title, severity, cwe } of securityHeaders) {
    if (!headers[header]) {
      findings.push(
        makeFinding(
          `url-missing-header-${header}`,
          title,
          severity,
          cwe,
          `The response is missing the ${header} security header. This leaves the application vulnerable to clickjacking, MIME-type sniffing attacks, and other browser-based exploits.`,
          `Add the ${header} header to your web server or framework configuration.\nFor Next.js, add it to next.config.ts headers() function.\nFor Express, use the helmet middleware.`,
          { control_ids: [27] }
        )
      )
    }
  }
  return findings
}

function detectInsecureTransport(urlHistory: string[]): EngineVulnerability[] {
  if (!urlHistory.some((url) => new URL(url).protocol === "http:")) return []
  return [
    makeFinding(
      "url-insecure-http",
      "Application is served over insecure HTTP",
      "HIGH",
      "CWE-319",
      "The target is reachable over cleartext HTTP, allowing network attackers to read or modify requests and responses.",
      "Redirect all HTTP traffic to HTTPS and enable HSTS after confirming every supported subdomain is HTTPS-ready.",
      { control_ids: [29] }
    ),
  ]
}

function detectInsecureCookies(headers: Record<string, string>): EngineVulnerability[] {
  const rawCookies = headers["set-cookie"]
  if (!rawCookies) return []

  const cookies = rawCookies.split(/\n|,(?=[^;,=\s]+=[^;,]+)/)
  const findings: EngineVulnerability[] = []
  for (const [index, cookie] of cookies.entries()) {
    const name = cookie.split("=", 1)[0]?.trim() ?? `cookie-${index + 1}`
    const looksSensitive = /session|auth|token|jwt|sid/i.test(name)
    if (!looksSensitive) continue

    const missing = [
      !/;\s*secure(?:;|$)/i.test(cookie) ? "Secure" : null,
      !/;\s*httponly(?:;|$)/i.test(cookie) ? "HttpOnly" : null,
      !/;\s*samesite=(?:strict|lax|none)(?:;|$)/i.test(cookie) ? "SameSite" : null,
    ].filter(Boolean) as string[]
    if (missing.length === 0) continue

    findings.push(
      makeFinding(
        `url-insecure-cookie-${index}`,
        `Sensitive cookie ${name} is missing ${missing.join(", ")}`,
        missing.includes("Secure") || missing.includes("HttpOnly") ? "HIGH" : "MEDIUM",
        missing.includes("Secure")
          ? "CWE-614"
          : missing.includes("HttpOnly")
            ? "CWE-1004"
            : "CWE-1275",
        `The ${name} cookie appears to carry authentication or session state but is missing required browser protections: ${missing.join(", ")}.`,
        "Set Secure, HttpOnly, and an explicit SameSite policy on every authentication and session cookie.",
        { control_ids: [28] }
      )
    )
  }
  return findings
}

function detectVerboseErrors(html: string): EngineVulnerability[] {
  const patterns = [
    /Traceback \(most recent call last\)/i,
    /\bat\s+[\w.$<>]+\s+\([^\n()]+:\d+:\d+\)/,
    /SQLSTATE\[[A-Z0-9]+\]/i,
    /Whoops, looks like something went wrong/i,
  ]
  if (!patterns.some((pattern) => pattern.test(html))) return []
  return [
    makeFinding(
      "url-verbose-error",
      "Verbose error or stack trace exposed",
      "MEDIUM",
      "CWE-209",
      "The response exposes a framework, database, or application stack trace that can reveal internal paths and implementation details.",
      "Return a generic error response to users, disable production debug mode, and send detailed errors only to access-controlled monitoring.",
      { control_ids: [31] }
    ),
  ]
}

function detectSourceMapExposure(html: string): EngineVulnerability[] {
  const hasSourceMap =
    /sourceMappingURL\s*=\s*[^\s"'<>]+\.map(?:\?[^\s"'<>]*)?/i.test(html) ||
    /(?:src|href)=["'][^"']+\.map(?:\?[^"']*)?["']/i.test(html)
  if (!hasSourceMap) return []
  return [
    makeFinding(
      "url-source-map-exposed",
      "Source map referenced by production page",
      "LOW",
      "CWE-540",
      "The production response references a JavaScript or CSS source map that may expose original source, internal routes, comments, or embedded configuration.",
      "Do not publish production source maps publicly. Upload them privately to the error-monitoring provider or require authenticated access.",
      { control_ids: [32] }
    ),
  ]
}

export async function scanUrl(config: UrlScanConfig): Promise<EngineVulnerability[]> {
  const { targetUrl, fetchFn, resolver, coverageIssues, signal } = config
  logger.info("Starting AI-builder-aware URL scan", { targetUrl: redactUrlForLogs(targetUrl) })

  const fetched = await fetchUrl(targetUrl, fetchFn, resolver, signal)
  if ("failureReason" in fetched) {
    logger.warn("URL scan skipped — could not fetch target", {
      targetUrl: redactUrlForLogs(targetUrl),
      reason: fetched.failureReason,
    })
    recordCoverageIssue(coverageIssues, {
      scanner: "url",
      status: "partial",
      subject: redactUrlForLogs(targetUrl),
      reason: `URL content could not be fetched: ${fetched.failureReason}`,
    })
    return []
  }

  const { html, headers, urlHistory } = fetched
  const allFindings: EngineVulnerability[] = []

  allFindings.push(...detectSupabasePrivilegedKey(html))
  allFindings.push(...detectExposedApiKeys(html))
  allFindings.push(...detectMissingSecurityHeaders(headers))
  allFindings.push(...detectInsecureTransport(urlHistory))
  allFindings.push(...detectInsecureCookies(headers))
  allFindings.push(...detectVerboseErrors(html))
  allFindings.push(...detectSourceMapExposure(html))

  logger.info("URL scan complete", {
    targetUrl: redactUrlForLogs(targetUrl),
    findings: allFindings.length,
  })
  return allFindings
}
