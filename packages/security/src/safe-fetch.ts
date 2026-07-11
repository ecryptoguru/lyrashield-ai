import { logger } from "@lyrashield/logger"
import { checkScanUrlSafe, type HostResolver } from "./ssrf"

/**
 * Fetch-time SSRF-safe HTTP client for the scan worker.
 *
 * The create-time `checkScanUrlSafe` guard in the API validates a target URL
 * when it is first registered. That is NOT sufficient at scan time: DNS can be
 * re-pointed after registration (rebinding), and a validated URL can 3xx-redirect
 * to an internal/metadata endpoint. This helper re-validates the URL — and every
 * redirect hop — immediately before the request, so the worker never fetches a
 * host that resolves into a blocked range.
 *
 * Defense applied here:
 *  - resolve + range-check the host on every hop (via `checkScanUrlSafe`, which
 *    canonicalizes alternate IP encodings and checks all resolved addresses)
 *  - `redirect: "manual"` so redirects are re-validated instead of auto-followed
 *  - a bounded hop count
 *
 * Residual (documented): there is still a small resolve→connect TOCTOU window
 * because Node's global fetch re-resolves DNS on connect. Closing it fully needs
 * an undici dispatcher with a pinning `lookup`; that is a deliberate follow-up
 * (avoids adding an undici dependency and TLS/SNI breakage from IP-host rewrites).
 * Even so, this is a large improvement over an unvalidated fetch: the rebinding
 * attacker must now win a millisecond-scale race rather than simply pointing DNS
 * at the metadata IP.
 */

export interface SafeFetchResult {
  html: string
  status: number
  headers: Record<string, string>
  finalUrl: string
}

export interface SafeFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
  maxBytes?: number
  userAgent?: string
  fetchFn?: typeof fetch
  /** Injectable DNS resolver — only for tests. */
  resolver?: HostResolver
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/**
 * Perform an SSRF-safe GET, following (and re-validating) redirects manually.
 * Returns `null` if the URL — or any redirect target — is unsafe or the request
 * fails. Never throws for an unsafe/blocked URL; it is logged and skipped.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult | null> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    userAgent = "LyraSec-Scanner/1.0",
    fetchFn = globalThis.fetch,
    resolver,
  } = options

  let currentUrl = rawUrl

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkScanUrlSafe(currentUrl, resolver)
    if (!check.safe) {
      logger.warn("safeFetch blocked URL (SSRF guard)", { url: currentUrl, reason: check.reason, hop })
      return null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": userAgent },
      })
    } catch (err) {
      clearTimeout(timer)
      logger.warn("safeFetch request failed", {
        url: currentUrl,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    clearTimeout(timer)

    if (!res || typeof res.status !== "number") {
      logger.warn("safeFetch received an invalid response", { url: currentUrl })
      return null
    }

    // Redirect: re-validate the next hop instead of letting fetch follow it.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location")
      if (!location) {
        logger.warn("safeFetch redirect without Location header", { url: currentUrl, status: res.status })
        return null
      }
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        logger.warn("safeFetch redirect to invalid URL", { url: currentUrl, location })
        return null
      }
      if (hop === maxRedirects) {
        logger.warn("safeFetch exceeded max redirects", { url: rawUrl, maxRedirects })
        return null
      }
      currentUrl = nextUrl
      continue
    }

    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })

    // Bound the body size so a hostile target can't exhaust worker memory.
    const html = await readBounded(res, maxBytes)
    return { html, status: res.status, headers, finalUrl: currentUrl }
  }

  return null
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        chunks.push(value)
        if (total >= maxBytes) break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8")
}
