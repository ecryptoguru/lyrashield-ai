import { logger } from "@lyrashield/logger"
import { isIP, type LookupFunction } from "node:net"
import { Agent, fetch as undiciFetch } from "undici"
import { redactUrlForLogs, resolveScanUrlSafe, type HostResolver } from "./ssrf"

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
 *  - resolve + range-check the host on every hop, then pin the connection to
 *    only those approved addresses
 *  - `redirect: "manual"` so redirects are re-validated instead of auto-followed
 *  - a bounded hop count
 *
 * The original hostname remains in the URL, so HTTP Host and TLS SNI behavior is
 * preserved while DNS rebinding cannot change the connection destination.
 */

export interface SafeFetchResult {
  html: string
  status: number
  headers: Record<string, string>
  finalUrl: string
  urlHistory: string[]
  /** Bytes actually read into the in-memory body. May be less than the response content-length. */
  bodyBytes: number
  /** True when the response body was capped before the end of the declared or observed stream. */
  bodyTruncated: boolean
}

export interface SafeFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
  maxBytes?: number
  userAgent?: string
  /** Test-only request implementation. Production requests use a DNS-pinned dispatcher. */
  fetchFn?: typeof fetch
  /** Injectable DNS resolver — only for tests. */
  resolver?: HostResolver
  /** Cancels the request and body read when its owning scan phase stops. */
  signal?: AbortSignal
}

export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

// Extra properties passed to a custom fetchFn (egress proxy) so per-hop limits
// stay in sync. They are ignored by the standard fetch API.

/**
 * Why a safe fetch did not return content.
 *
 * These are deliberately distinct. Collapsing them into a single `null` made a
 * production failure undiagnosable: a blocked-by-policy URL, a DNS failure, a
 * TLS handshake error, a timeout and a hostile-redirect refusal all surfaced to
 * the operator as the same "could not be fetched" line, with no way to tell an
 * infrastructure problem from the guard doing its job.
 */
export type SafeFetchFailureReason =
  /** The URL (or a redirect hop) resolved into a blocked range — the guard working as intended. */
  | "ssrf_blocked"
  /** DNS resolution did not complete before the timeout, or the caller aborted during it. */
  | "dns_timeout"
  /** Transport-level failure: connection refused, TLS handshake error, socket timeout. */
  | "request_failed"
  /** The response object was malformed. */
  | "invalid_response"
  /** A 3xx carried no Location header. */
  | "redirect_no_location"
  /** A 3xx Location could not be parsed into a URL. */
  | "redirect_invalid_url"
  /** The redirect chain exceeded maxRedirects. */
  | "too_many_redirects"
  /** The response arrived but the body could not be read within limits. */
  | "body_read_failed"
  /** The owning scan phase cancelled before the request started. */
  | "aborted"

export type SafeFetchOutcome =
  | { ok: true; result: SafeFetchResult }
  | { ok: false; reason: SafeFetchFailureReason; detail?: string }

/** Human-readable, operator-facing explanation for each failure reason. */
export const SAFE_FETCH_REASON_TEXT: Record<SafeFetchFailureReason, string> = {
  ssrf_blocked: "blocked by the SSRF guard — the host resolved into a disallowed address range",
  dns_timeout: "DNS resolution did not complete before the timeout",
  request_failed: "the connection failed (refused, TLS error, or socket timeout)",
  invalid_response: "the server returned a malformed response",
  redirect_no_location: "the server sent a redirect with no Location header",
  redirect_invalid_url: "the server redirected to an unparseable URL",
  too_many_redirects: "the redirect chain exceeded the allowed number of hops",
  body_read_failed: "the response body could not be read within the size limit",
  aborted: "the scan phase was cancelled before the request completed",
}

/**
 * Error thrown by an egress-proxy `fetchFn` when the proxy refuses a request.
 * Carrying the typed reason lets `safeFetchOnce` surface it without losing the
 * diagnostic that the worker-side guard would have produced.
 */
export class EgressProxyError extends Error {
  constructor(
    public reason: SafeFetchFailureReason,
    public detail?: string
  ) {
    super(`Egress proxy refused fetch: ${reason}${detail ? ` (${detail})` : ""}`)
    this.name = "EgressProxyError"
  }
}

/**
 * Perform an SSRF-safe GET, following (and re-validating) redirects manually.
 * Returns `null` if the URL — or any redirect target — is unsafe or the request
 * fails. Never throws for an unsafe/blocked URL; it is logged and skipped.
 *
 * Prefer {@link safeFetchDetailed} in new code: this wrapper discards the reason
 * the fetch failed, which is exactly the information an operator needs.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult | null> {
  const outcome = await safeFetchDetailed(rawUrl, options)
  return outcome.ok ? outcome.result : null
}

/**
 * Same request semantics as {@link safeFetch}, but reports WHY it failed so the
 * caller can tell the operator whether the target was unreachable, blocked by
 * policy, or misbehaving.
 */
export async function safeFetchDetailed(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchOutcome> {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, signal: externalSignal } = options

  let currentUrl = rawUrl
  const urlHistory: string[] = []

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (externalSignal?.aborted) return { ok: false, reason: "aborted" }

    urlHistory.push(currentUrl)
    const outcome = await safeFetchOnce(currentUrl, options)

    if (!outcome.ok) return outcome

    const { result } = outcome

    if (result.status >= 300 && result.status < 400) {
      const location = result.headers["location"]
      if (!location) {
        logger.warn("safeFetch redirect without Location header", {
          url: redactUrlForLogs(currentUrl),
          status: result.status,
        })
        return { ok: false, reason: "redirect_no_location" }
      }
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        logger.warn("safeFetch redirect to invalid URL", { url: redactUrlForLogs(currentUrl) })
        return { ok: false, reason: "redirect_invalid_url" }
      }
      if (hop === maxRedirects) {
        logger.warn("safeFetch exceeded max redirects", {
          url: redactUrlForLogs(rawUrl),
          maxRedirects,
        })
        return { ok: false, reason: "too_many_redirects" }
      }
      currentUrl = nextUrl
      continue
    }

    return {
      ok: true,
      result: { ...result, finalUrl: currentUrl, urlHistory },
    }
  }

  return { ok: false, reason: "too_many_redirects" }
}

/**
 * SSRF-safe single-hop fetch. Resolves and validates the URL, pins the
 * connection to the resolved addresses, and returns the raw (non-followed)
 * response. Used directly by the egress proxy and by {@link safeFetchDetailed}
 * for each redirect hop.
 *
 * If `fetchFn` is provided, the pinning step is skipped and the caller-supplied
 * fetch implementation is used instead. This is how the worker routes URL scans
 * through the authenticated egress proxy while keeping the worker-side SSRF
 * checks and redirect handling intact.
 */
export async function safeFetchOnce(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchOutcome> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    userAgent = "LyraShield-Scanner/1.0",
    fetchFn,
    resolver,
    signal: externalSignal,
  } = options

  if (externalSignal?.aborted) return { ok: false, reason: "aborted" }

  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const check = await Promise.race([
    resolveScanUrlSafe(rawUrl, resolver),
    new Promise<null>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(null), { once: true })
    ),
  ])
  if (!check) {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    return { ok: false, reason: "dns_timeout" }
  }
  if (!check.safe) {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    logger.warn("safeFetch blocked URL (SSRF guard)", {
      url: redactUrlForLogs(rawUrl),
      reason: check.reason,
    })
    return { ok: false, reason: "ssrf_blocked", detail: check.reason }
  }

  const headers: Record<string, string> = {
    "User-Agent": userAgent,
  }

  const dispatcher = fetchFn ? undefined : createPinnedDispatcher(check.addresses)
  let res: Response
  try {
    const baseInit = {
      method: "GET",
      redirect: "manual" as const,
      signal: controller.signal,
      headers,
    }
    res = fetchFn
      ? await fetchFn(rawUrl, { ...baseInit, timeoutMs, maxBytes } as RequestInit)
      : ((await undiciFetch(rawUrl, { ...baseInit, dispatcher } as never)) as unknown as Response)
  } catch (err) {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    await dispatcher?.destroy()

    if (err instanceof EgressProxyError) {
      return { ok: false, reason: err.reason, detail: err.detail }
    }

    const detail = err instanceof Error ? err.message : String(err)
    logger.warn("safeFetch request failed", {
      url: redactUrlForLogs(rawUrl),
      error: detail,
    })
    return { ok: false, reason: "request_failed", detail }
  }
  if (!res || typeof res.status !== "number") {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    await dispatcher?.destroy()
    logger.warn("safeFetch received an invalid response", { url: redactUrlForLogs(rawUrl) })
    return { ok: false, reason: "invalid_response" }
  }

  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value
  })

  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {})
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    await dispatcher?.destroy()
    return {
      ok: true,
      result: {
        html: "",
        status: res.status,
        headers: responseHeaders,
        finalUrl: rawUrl,
        urlHistory: [rawUrl],
        bodyBytes: 0,
        bodyTruncated: false,
      },
    }
  }

  try {
    const { html, bodyBytes, bodyTruncated } = await readBounded(res, maxBytes)
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    await dispatcher?.destroy()
    return {
      ok: true,
      result: {
        html,
        status: res.status,
        headers: responseHeaders,
        finalUrl: rawUrl,
        urlHistory: [rawUrl],
        bodyBytes,
        bodyTruncated,
      },
    }
  } catch (err) {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
    await dispatcher?.destroy()
    const detail = err instanceof Error ? err.message : String(err)
    logger.warn("safeFetch response body read failed", {
      url: redactUrlForLogs(rawUrl),
      error: detail,
    })
    return { ok: false, reason: "body_read_failed", detail }
  }
}

function createPinnedDispatcher(addresses: string[]): Agent {
  const records = addresses.map((address) => ({ address, family: isIP(address) }))
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, records)
    else callback(null, records[0]?.address ?? "", records[0]?.family)
  }
  return new Agent({ connect: { lookup } })
}

async function readBounded(
  res: Response,
  maxBytes: number
): Promise<{ html: string; bodyBytes: number; bodyTruncated: boolean }> {
  const contentLengthHeader = res.headers.get("content-length")
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN

  if (!res.body) {
    const html = await res.text()
    const bodyBytes = Buffer.byteLength(html, "utf8")
    const bodyTruncated = Number.isFinite(contentLength) ? bodyBytes < contentLength : false
    return { html, bodyBytes, bodyTruncated }
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let bodyTruncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        bodyTruncated = Number.isFinite(contentLength) && total < contentLength
        break
      }
      if (value) {
        const remaining = Math.max(0, maxBytes - total)
        if (remaining === 0) {
          bodyTruncated = true
          break
        }

        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          bodyTruncated = true
          break
        }

        chunks.push(value)
        total += value.byteLength
        if (total === maxBytes) {
          bodyTruncated = true
          break
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8")
  return { html, bodyBytes: total, bodyTruncated }
}
