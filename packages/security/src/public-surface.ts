import {
  URL_SCAN_CONTRACT_VERSION,
  type UrlRequestMethod,
  type UrlScanProfile,
} from "@lyrashield/types"
import { redactUrlForLogs, type HostResolver } from "./ssrf"
import {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  safeFetchDetailed,
  type SafeFetchResult,
} from "./safe-fetch"

export type SurfaceSubjectKind =
  | "document"
  | "asset"
  | "robots"
  | "sitemap"
  | "source_map"
  | "api_spec"
  | "api_operation"
  | "probe"

export type SurfaceSubject = {
  kind: SurfaceSubjectKind
  requestedUrl: string
  finalUrl: string
  urlHistory: string[]
  method: UrlRequestMethod
  status: number
  headers: Record<string, string>
  body: string
  bodyBytes: number
  bodyTruncated: boolean
  depth: number
}

export type SurfaceCollectionIssue = {
  code:
    | "FETCH_FAILED"
    | "LIMIT_REACHED"
    | "OUT_OF_SCOPE"
    | "UNSUPPORTED_CONTENT"
    | "AUTHENTICATION_REQUIRED"
    | "PARAMETER_VALUE_UNAVAILABLE"
    | "SCHEMA_UNSUPPORTED"
  subject: string
  reason: string
}

export type SurfaceCollection = {
  seedUrl: string
  finalOrigin: string
  contractVersion: typeof URL_SCAN_CONTRACT_VERSION
  profile: UrlScanProfile
  subjects: SurfaceSubject[]
  issues: SurfaceCollectionIssue[]
  totalBytes: number
  truncated: boolean
}

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol)) return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function normalizeDiscoveredUrl(
  raw: string,
  base: string,
  allowedOrigin: string
): string | null {
  try {
    const url = new URL(raw, base)
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== allowedOrigin) {
      return null
    }
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function describeOutcome(result: { ok: false; reason: string; detail?: string }): string {
  const reasons: Record<string, string> = {
    ssrf_blocked: "blocked by the SSRF guard",
    dns_timeout: "DNS resolution timed out",
    request_failed: "the connection failed",
    invalid_response: "the server returned a malformed response",
    redirect_no_location: "the redirect had no Location header",
    redirect_invalid_url: "the redirect target was unparseable",
    too_many_redirects: "too many redirects",
    body_read_failed: "the response body could not be read",
    aborted: "the scan phase was cancelled",
  }
  const base = reasons[result.reason] ?? result.reason
  return result.detail ? `${base} (${result.detail})` : base
}

function issue(
  code: SurfaceCollectionIssue["code"],
  subject: string,
  reason: string
): SurfaceCollectionIssue {
  return {
    code,
    subject: redactUrlForLogs(subject),
    reason: reason.replace(/\?[^\s]*/g, "").replace(/#[^\s]*/g, ""),
  }
}

function toSubject(
  kind: SurfaceSubjectKind,
  requestedUrl: string,
  result: SafeFetchResult,
  depth: number
): SurfaceSubject {
  return {
    kind,
    requestedUrl: redactUrlForLogs(requestedUrl),
    finalUrl: redactUrlForLogs(result.finalUrl),
    urlHistory: result.urlHistory.map(redactUrlForLogs),
    method: "GET",
    status: result.status,
    headers: result.headers,
    body: result.html,
    bodyBytes: result.bodyBytes,
    bodyTruncated: result.bodyTruncated,
    depth,
  }
}

function extractAssetUrls(html: string, base: string, allowedOrigin: string): string[] {
  const urls = new Set<string>()
  const attributes = html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)
  for (const match of attributes) {
    const raw = match[1]
    if (!raw) continue
    const normalized = normalizeDiscoveredUrl(raw, base, allowedOrigin)
    if (!normalized) continue
    const url = new URL(normalized)
    if (!/\.(?:m?js|css)$/i.test(url.pathname)) continue
    urls.add(normalized)
  }
  return [...urls].sort()
}

function combineSignal(
  wallTimeMs: number,
  externalSignal?: AbortSignal
): { controller: AbortController; signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), wallTimeMs)

  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

  const cleanup = () => {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
  }

  return { controller, signal: controller.signal, cleanup }
}

export async function collectPublicSurface(options: {
  seedUrl: string
  profile: UrlScanProfile
  userAgent?: string
  fetchFn?: typeof fetch
  resolver?: HostResolver
  signal?: AbortSignal
}): Promise<SurfaceCollection> {
  const { seedUrl, profile, userAgent, fetchFn, resolver, signal: externalSignal } = options

  const seed = normalizeUrl(seedUrl)
  const issues: SurfaceCollectionIssue[] = []
  const subjects: SurfaceSubject[] = []
  let totalBytes = 0
  let truncated = false

  if (!seed) {
    issues.push(issue("FETCH_FAILED", seedUrl, "The seed URL was not a valid HTTP/HTTPS URL."))
    return {
      seedUrl: redactUrlForLogs(seedUrl),
      finalOrigin: "",
      contractVersion: URL_SCAN_CONTRACT_VERSION,
      profile,
      subjects,
      issues,
      totalBytes,
      truncated,
    }
  }

  const { signal, cleanup } = combineSignal(profile.maxWallTimeMs, externalSignal)

  try {
    const seedOutcome = await safeFetchDetailed(seed, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      maxBytes: Math.min(profile.maxResponseBytes, profile.maxTotalBytes),
      userAgent,
      fetchFn,
      resolver,
      signal,
    })

    if (!seedOutcome.ok) {
      if (signal.aborted) {
        truncated = true
        issues.push(issue("LIMIT_REACHED", seed, "Scan wall-time budget was exhausted."))
      } else {
        issues.push(issue("FETCH_FAILED", seed, describeOutcome(seedOutcome)))
      }
      return {
        seedUrl: redactUrlForLogs(seed),
        finalOrigin: "",
        contractVersion: URL_SCAN_CONTRACT_VERSION,
        profile,
        subjects,
        issues,
        totalBytes,
        truncated,
      }
    }

    const seedResult = seedOutcome.result
    const finalOrigin = new URL(seedResult.finalUrl).origin
    subjects.push(toSubject("document", seed, seedResult, 0))
    totalBytes += seedResult.bodyBytes
    if (seedResult.bodyTruncated) {
      truncated = true
      issues.push(
        issue(
          "LIMIT_REACHED",
          seedResult.finalUrl,
          `Response body truncated at ${seedResult.bodyBytes} bytes.`
        )
      )
    }

    if (profile.mode === "SAFE" && profile.targetType === "WEB_APP") {
      const assetUrls = extractAssetUrls(seedResult.html, seedResult.finalUrl, finalOrigin)
      const cappedAssets = assetUrls.slice(0, profile.maxAssets)
      if (cappedAssets.length < assetUrls.length) {
        truncated = true
        issues.push(
          issue(
            "LIMIT_REACHED",
            seedResult.finalUrl,
            `Asset limit of ${profile.maxAssets} reached.`
          )
        )
      }

      let reservedBytes = 0
      const executing = new Set<Promise<void>>()

      for (const assetUrl of cappedAssets) {
        if (signal.aborted) {
          truncated = true
          break
        }

        const remaining = profile.maxTotalBytes - totalBytes - reservedBytes
        if (remaining <= 0) {
          truncated = true
          issues.push(
            issue(
              "LIMIT_REACHED",
              seedResult.finalUrl,
              `Total byte budget of ${profile.maxTotalBytes} bytes reached.`
            )
          )
          break
        }

        const maxSpend = Math.min(profile.maxResponseBytes, remaining)
        reservedBytes += maxSpend

        const task = (async () => {
          try {
            const outcome = await safeFetchDetailed(assetUrl, {
              timeoutMs: DEFAULT_TIMEOUT_MS,
              maxRedirects: DEFAULT_MAX_REDIRECTS,
              maxBytes: maxSpend,
              userAgent,
              fetchFn,
              resolver,
              signal,
            })

            if (!outcome.ok) {
              if (signal.aborted) {
                truncated = true
                issues.push(issue("LIMIT_REACHED", assetUrl, "Scan wall-time budget was exhausted."))
              } else {
                issues.push(issue("FETCH_FAILED", assetUrl, describeOutcome(outcome)))
              }
              return
            }

            const result = outcome.result
            if (new URL(result.finalUrl).origin !== finalOrigin) {
              issues.push(issue("OUT_OF_SCOPE", result.finalUrl, "Asset redirected out of the target origin."))
              return
            }

            subjects.push(toSubject("asset", assetUrl, result, 1))
            totalBytes += result.bodyBytes
            if (result.bodyTruncated) {
              truncated = true
              issues.push(
                issue(
                  "LIMIT_REACHED",
                  result.finalUrl,
                  `Response body truncated at ${result.bodyBytes} bytes.`
                )
              )
            }
          } finally {
            reservedBytes -= maxSpend
          }
        })()

        executing.add(task)
        task.finally(() => executing.delete(task))

        if (executing.size >= profile.maxConcurrency) {
          await Promise.race(executing)
        }
      }

      await Promise.all(executing)
    }

    return {
      seedUrl: redactUrlForLogs(seed),
      finalOrigin,
      contractVersion: URL_SCAN_CONTRACT_VERSION,
      profile,
      subjects,
      issues,
      totalBytes,
      truncated,
    }
  } finally {
    cleanup()
  }
}
