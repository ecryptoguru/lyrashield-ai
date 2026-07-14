/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { logger } from "@lyrashield/logger"
import { readFile } from "fs/promises"
import { join } from "path"
import { redactUrlForLogs, safeFetch, type HostResolver } from "@lyrashield/security"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

export interface UrlScanConfig {
  targetUrl: string
  repoPath?: string
  fetchFn?: typeof fetch
  /** Injectable DNS resolver — only for tests. */
  resolver?: HostResolver
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
}

const AI_BUILDER_PLATFORMS = [
  "lovable",
  "bolt.new",
  "v0.dev",
  "replit",
  "base44",
  "cursor",
  "windsurf",
  "v0",
] as const

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
): Promise<{
  html: string
  status: number
  headers: Record<string, string>
  finalUrl: string
  urlHistory: string[]
} | null> {
  const result = await safeFetch(url, { fetchFn, resolver, signal })
  if (!result) return null
  return {
    html: result.html,
    status: result.status,
    headers: result.headers,
    finalUrl: result.finalUrl,
    urlHistory: result.urlHistory,
  }
}

function detectSupabaseAnonKey(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const supabaseKeyPattern = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  const supabaseUrlPattern = /https:\/\/[a-z0-9]+\.supabase\.co/i
  const hasSupabaseUrl = supabaseUrlPattern.test(html)
  const matches = html.match(supabaseKeyPattern)
  if (matches && hasSupabaseUrl) {
    for (let i = 0; i < matches.length; i++) {
      findings.push(
        makeFinding(
          `url-supabase-anon-key-${i}`,
          "Exposed Supabase anon key in client bundle",
          "HIGH",
          "CWE-200",
          "A Supabase JWT (anon key) is embedded in the client-side JavaScript. While anon keys are designed for client use, they can be exploited if Row Level Security (RLS) policies are missing or misconfigured, allowing unauthenticated access to all table data.",
          "1. Verify that RLS is enabled on all tables in the Supabase dashboard.\n2. Create policies that restrict access based on auth.uid().\n3. Never use the service_role key in client-side code.\n4. Consider using Supabase Edge Functions for sensitive operations.",
          {
            poc_description: `Extract the anon key from page source and use it with the Supabase client to query tables directly. If RLS is not enabled, all data is accessible without authentication.`,
            technical_analysis:
              "AI builders like Lovable and Bolt commonly embed Supabase anon keys in client bundles. The anon key alone is not a vulnerability, but combined with missing RLS policies it enables full data exfiltration. This is the root cause of the Lovable CVE-2025-48757 incident.",
          }
        )
      )
    }
  }
  return findings
}

function detectFirebaseConfig(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const firebaseConfigPattern = /firebaseConfig\s*=\s*\{[^}]*apiKey\s*:\s*["']([A-Za-z0-9_-]+)["']/i
  const match = html.match(firebaseConfigPattern)
  if (match) {
    findings.push(
      makeFinding(
        "url-firebase-config-exposed",
        "Exposed Firebase API key in client configuration",
        "MEDIUM",
        "CWE-200",
        "A Firebase API key is embedded in the client-side Firebase configuration. While Firebase API keys are designed for client use, they can be exploited if Firebase Security Rules are permissive (e.g., allow read/write to all users).",
        "1. Review Firebase Security Rules in the Firebase Console.\n2. Ensure rules require authentication for sensitive operations.\n3. Restrict the API key to your domain in Google Cloud Console.\n4. Enable App Check for additional verification.",
        {
          technical_analysis:
            "AI builders like Bolt and v0 often generate Firebase configurations with permissive default rules. The API key is identifiable by the 'AIza' prefix and is safe to expose only if Security Rules are properly configured.",
        }
      )
    )
  }
  return findings
}

function detectExposedApiKeys(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const hasFirebaseConfig = /firebaseConfig\s*=/i.test(html)
  const patterns = [
    {
      regex: /(?:api[_-]?key|apikey)\s*[=:]\s*["']([A-Za-z0-9_-]{20,})["']/gi,
      name: "generic-api-key",
      cwe: "CWE-200",
    },
    { regex: /sk_live_[A-Za-z0-9]{20,}/g, name: "stripe-secret-key", cwe: "CWE-200" },
    { regex: /AKIA[0-9A-Z]{16}/g, name: "aws-access-key", cwe: "CWE-200" },
    { regex: /gh[pousr]_[A-Za-z0-9]{36}/g, name: "github-token", cwe: "CWE-200" },
    // Skip Google API key pattern if Firebase config is present — it's already reported by detectFirebaseConfig
    ...(hasFirebaseConfig
      ? []
      : [{ regex: /AIza[0-9A-Za-z_-]{35}/g, name: "google-api-key", cwe: "CWE-200" }]),
  ]
  for (const { regex, name, cwe } of patterns) {
    const matches = html.match(regex)
    if (matches) {
      for (let i = 0; i < matches.length; i++) {
        findings.push(
          makeFinding(
            `url-exposed-key-${name}-${i}`,
            `Exposed ${name.replace(/-/g, " ")} in client-side code`,
            "HIGH",
            cwe,
            `A ${name.replace(/-/g, " ")} was found embedded in the page source. This key could be extracted by anyone visiting the site and used for unauthorized access.`,
            "1. Move the key to a server-side environment variable.\n2. Rotate the exposed key immediately.\n3. Use a backend proxy for API calls requiring the key.\n4. Implement rate limiting on the API to reduce impact if keys are leaked.",
            {
              poc_description: `Extract the key from the page source and use it directly against the corresponding service API.`,
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
          `Add the ${header} header to your web server or framework configuration.\nFor Next.js, add it to next.config.ts headers() function.\nFor Express, use the helmet middleware.`
        )
      )
    }
  }
  return findings
}

function detectCorsMisconfiguration(headers: Record<string, string>): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const corsHeader = headers["access-control-allow-origin"]
  if (corsHeader === "*") {
    const credsHeader = headers["access-control-allow-credentials"]
    if (credsHeader === "true") {
      findings.push(
        makeFinding(
          "url-cors-wildcard-with-credentials",
          "CORS allows all origins with credentials",
          "HIGH",
          "CWE-942",
          "The server responds with Access-Control-Allow-Origin: * and Access-Control-Allow-Credentials: true. This is a dangerous misconfiguration that allows any website to make authenticated cross-origin requests to this server.",
          "1. Restrict Access-Control-Allow-Origin to specific trusted domains.\n2. Never combine wildcard origin with credentials.\n3. Use a whitelist of allowed origins instead of *.",
          {
            poc_description:
              "From any malicious website, use fetch() with credentials: 'include' to read responses from this server, stealing user data or session tokens.",
          }
        )
      )
    } else {
      findings.push(
        makeFinding(
          "url-cors-wildcard",
          "CORS allows all origins",
          "LOW",
          "CWE-942",
          "The server responds with Access-Control-Allow-Origin: *. While this is common for public APIs, it should be restricted for applications handling user data.",
          "Restrict Access-Control-Allow-Origin to specific trusted domains rather than using a wildcard."
        )
      )
    }
  }
  return findings
}

function detectIdorPatterns(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const idPatterns = [
    { regex: /\/api\/[^"'<>]*\?id=\d+/gi, name: "numeric-id-in-url" },
    { regex: /\/api\/users\/\d+/gi, name: "sequential-user-id" },
    { regex: /\/api\/[^"'<>]*\?user_?id=\d+/gi, name: "user-id-param" },
  ]
  for (const { regex, name } of idPatterns) {
    const matches = html.match(regex)
    if (matches) {
      findings.push(
        makeFinding(
          `url-idor-pattern-${name}`,
          `Potential IDOR vulnerability detected (${name})`,
          "MEDIUM",
          "CWE-639",
          "The application uses predictable numeric identifiers in API URLs. If the server does not properly authorize access, an attacker could enumerate IDs to access other users' data.",
          "1. Use UUIDs instead of sequential numeric IDs.\n2. Implement server-side authorization checks for every resource access.\n3. Verify that the requesting user owns or has access to the requested resource.\n4. Add rate limiting to prevent enumeration attacks.",
          {
            poc_description:
              "Increment or decrement the ID parameter in the API URL and observe whether other users' data is returned without authorization errors.",
            technical_analysis:
              "AI builders often generate CRUD APIs with sequential IDs and forget to add per-resource authorization checks. This is a common pattern in Lovable and Bolt-generated applications.",
          }
        )
      )
      break
    }
  }
  return findings
}

async function detectMissingWebhookVerification(
  html: string,
  repoPath?: string
): Promise<EngineVulnerability[]> {
  const findings: EngineVulnerability[] = []
  const webhookPatterns = [
    { regex: /webhook/i, context: /stripe|payment|checkout/i, name: "stripe-webhook" },
    { regex: /\/webhook/i, context: /github|push|pull_request/i, name: "github-webhook" },
  ]
  for (const { regex, context, name } of webhookPatterns) {
    if (regex.test(html) && context.test(html)) {
      const hasVerification =
        /stripe-signature|x-hub-signature|constructEvent|verifySignature|webhooks\.construct/i.test(
          html
        )
      if (!hasVerification) {
        findings.push(
          makeFinding(
            `url-webhook-no-verification-${name}`,
            `Missing webhook signature verification (${name})`,
            "HIGH",
            "CWE-345",
            `A ${name} endpoint was detected but no signature verification logic was found. Without verifying webhook signatures, an attacker could send fake webhook events to trigger unauthorized actions like marking invoices as paid or triggering CI/CD pipelines.`,
            `1. Verify the webhook signature for every incoming request.\n2. For Stripe: use stripe.webhooks.constructEvent() with the webhook signing secret.\n3. For GitHub: verify the x-hub-signature-256 header using HMAC-SHA256.\n4. Reject any request with an invalid or missing signature.`,
            {
              technical_analysis:
                "AI builders frequently generate webhook handlers without adding signature verification, as it requires platform-specific secrets that aren't available during code generation.",
            }
          )
        )
      }
    }
  }
  if (repoPath) {
    const repoFindings = await detectWebhookInRepo(repoPath)
    findings.push(...repoFindings)
  }
  return findings
}

async function detectWebhookInRepo(repoPath: string): Promise<EngineVulnerability[]> {
  const findings: EngineVulnerability[] = []
  const webhookFiles = [
    "src/app/api/webhooks/stripe/route.ts",
    "src/app/api/webhooks/github/route.ts",
    "api/webhook.ts",
    "src/routes/webhook.ts",
  ]
  for (const file of webhookFiles) {
    try {
      const content = await readFile(join(repoPath, file), "utf-8")
      const hasVerification =
        /stripe-signature|x-hub-signature|constructEvent|verifySignature|webhooks\.construct|timingSafeEqual/i.test(
          content
        )
      if (!hasVerification) {
        findings.push(
          makeFinding(
            `url-webhook-no-verification-file-${file}`,
            `Missing webhook signature verification in ${file}`,
            "HIGH",
            "CWE-345",
            `A webhook handler at ${file} does not verify the incoming request signature. This allows attackers to send forged webhook events.`,
            "Add signature verification using the platform's SDK (e.g., stripe.webhooks.constructEvent for Stripe, crypto.timingSafeEqual for GitHub)."
          )
        )
      }
    } catch {
      // File doesn't exist — skip
    }
  }
  return findings
}

function detectAiBuilderDefaults(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const lowerHtml = html.toLowerCase()
  for (const platform of AI_BUILDER_PLATFORMS) {
    if (lowerHtml.includes(platform)) {
      findings.push(
        makeFinding(
          `url-ai-builder-${platform}`,
          `Application built with ${platform} — verify security defaults`,
          "INFO",
          "CWE-693",
          `This application appears to have been built with ${platform}. AI-generated applications commonly have security gaps including missing RLS policies, exposed API keys, permissive CORS, and missing webhook verification. A thorough security review is recommended.`,
          `1. Review all database access policies (RLS for Supabase, Security Rules for Firebase).\n2. Ensure no service-role keys are in client code.\n3. Verify all API endpoints have proper authorization.\n4. Check webhook signature verification.\n5. Run a full LyraShield scan for comprehensive coverage.`,
          {
            technical_analysis: `AI builder platforms like ${platform} generate functional code quickly but often skip security hardening. Common issues: default permissive database rules, exposed credentials in client bundles, missing input validation, and no webhook verification.`,
          }
        )
      )
      break
    }
  }
  return findings
}

function detectOpenRedirects(html: string): EngineVulnerability[] {
  const findings: EngineVulnerability[] = []
  const redirectPatterns = [
    {
      regex: /(?:redirect|next|return_?url|callback)\s*[=:]\s*["']?\s*(?:https?:)?\/\//gi,
      name: "redirect-param",
    },
    { regex: /window\.location(?:\.href)?\s*=\s*[a-zA-Z_$]/gi, name: "dynamic-redirect" },
  ]
  for (const { regex, name } of redirectPatterns) {
    const matches = html.match(regex)
    if (matches) {
      findings.push(
        makeFinding(
          `url-open-redirect-${name}`,
          `Potential open redirect (${name})`,
          "MEDIUM",
          "CWE-601",
          "The application contains redirect logic that may use user-controlled input without validation. Open redirects can be used for phishing attacks and OAuth token theft.",
          "1. Validate redirect URLs against a whitelist of allowed domains.\n2. Use relative paths for internal redirects.\n3. Never redirect to URLs from query parameters without validation."
        )
      )
      break
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
      "Redirect all HTTP traffic to HTTPS and enable HSTS after confirming every supported subdomain is HTTPS-ready."
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
        "Set Secure, HttpOnly, and an explicit SameSite policy on every authentication and session cookie."
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
      "Return a generic error response to users, disable production debug mode, and send detailed errors only to access-controlled monitoring."
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
      "Do not publish production source maps publicly. Upload them privately to the error-monitoring provider or require authenticated access."
    ),
  ]
}

export async function scanUrl(config: UrlScanConfig): Promise<EngineVulnerability[]> {
  const { targetUrl, repoPath, fetchFn, resolver, coverageIssues, signal } = config
  logger.info("Starting AI-builder-aware URL scan", { targetUrl: redactUrlForLogs(targetUrl) })

  const result = await fetchUrl(targetUrl, fetchFn, resolver, signal)
  if (!result) {
    logger.warn("URL scan skipped — could not fetch target", {
      targetUrl: redactUrlForLogs(targetUrl),
    })
    recordCoverageIssue(coverageIssues, {
      scanner: "url",
      status: "partial",
      subject: redactUrlForLogs(targetUrl),
      reason: "URL content could not be fetched through the SSRF-safe transport",
    })
    return []
  }

  const { html, headers, urlHistory } = result
  const allFindings: EngineVulnerability[] = []

  allFindings.push(...detectSupabaseAnonKey(html))
  allFindings.push(...detectFirebaseConfig(html))
  allFindings.push(...detectExposedApiKeys(html))
  allFindings.push(...detectMissingSecurityHeaders(headers))
  allFindings.push(...detectCorsMisconfiguration(headers))
  allFindings.push(...detectIdorPatterns(html))
  allFindings.push(...(await detectMissingWebhookVerification(html, repoPath)))
  allFindings.push(...detectAiBuilderDefaults(html))
  allFindings.push(...detectOpenRedirects(html))
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

export async function scanUrlFromRepo(
  repoPath: string,
  targetUrl: string,
  fetchFn?: typeof fetch
): Promise<EngineVulnerability[]> {
  return scanUrl({ targetUrl, repoPath, fetchFn })
}
