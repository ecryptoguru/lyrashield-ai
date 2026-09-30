import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { EgressProxyError, SAFE_FETCH_REASON_TEXT, type SafeFetchFailureReason } from "./safe-fetch"
import { redactUrlForLogs } from "./ssrf"

const ProxyOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.object({
      html: z.string(),
      status: z.number().int().min(200).max(599),
      headers: z.record(z.string(), z.string()),
    }),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.custom<SafeFetchFailureReason>(
      (value) => typeof value === "string" && Object.hasOwn(SAFE_FETCH_REASON_TEXT, value)
    ),
    detail: z.string().optional(),
  }),
])

interface ProxyFetchInit extends RequestInit {
  timeoutMs?: number
  maxBytes?: number
}

export interface EgressProxyFetchFnOptions {
  url: string
  secret: string
  /** Connect timeout for the proxy round-trip in ms (default 10s). */
  connectTimeoutMs?: number
  /** Read timeout for the proxy round-trip in ms (default 30s). */
  readTimeoutMs?: number
}

/**
 * Create a `fetch` implementation that forwards each hop to the authenticated
 * LyraShield egress proxy. The proxy performs its own SSRF validation, fetches
 * the public target, and returns the raw response body so the worker's existing
 * redirect handling and byte bounds stay in effect.
 *
 * Returns `undefined` when no proxy is configured, so callers fall back to the
 * default direct (DNS-pinned) fetch path.
 */
export function createEgressProxyFetchFn(
  options: EgressProxyFetchFnOptions
): typeof fetch | undefined {
  const { url: baseUrl, secret, connectTimeoutMs = 10_000, readTimeoutMs = 30_000 } = options
  if (!baseUrl || !secret) return undefined

  const proxyUrl = new URL("/v1/fetch", baseUrl).toString()

  // The total round-trip timeout is the connect + read budget. A hung upstream
  // behind the proxy must not stall the scan indefinitely.
  const totalTimeoutMs = connectTimeoutMs + readTimeoutMs

  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const normalizedUrl =
      input instanceof Request ? input.url : typeof input === "string" ? input : input.toString()

    const proxyInit = init as ProxyFetchInit
    const timeoutMs = proxyInit.timeoutMs
    const maxBytes = proxyInit.maxBytes
    const proxyHeaders = new Headers(init.headers)
    const userAgent = proxyHeaders.get("user-agent") ?? undefined

    // Combine the caller's signal with our own timeout so either can abort.
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), totalTimeoutMs)

    // If the caller provides a signal, propagate its abort to our controller.
    const callerSignal = init.signal
    const onCallerAbort = () => timeoutController.abort()
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer)
        throw new EgressProxyError("aborted", "caller signal already aborted")
      }
      callerSignal.addEventListener("abort", onCallerAbort, { once: true })
    }

    let response: Response
    try {
      response = await fetch(proxyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          url: normalizedUrl,
          userAgent,
          timeoutMs,
          maxBytes,
        }),
        signal: timeoutController.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)

      // Distinguish a timeout abort from a caller abort.
      const isTimeout =
        !callerSignal?.aborted && err instanceof DOMException && err.name === "AbortError"
      const detail = isTimeout
        ? `egress proxy round-trip timed out after ${totalTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err)
      logger.warn("egress proxy request failed", {
        url: redactUrlForLogs(normalizedUrl),
        error: detail,
      })
      throw new EgressProxyError("request_failed", detail)
    }

    if (!response.ok) {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
      const detail = `Proxy returned HTTP ${response.status}`
      logger.warn("egress proxy returned failure status", {
        url: redactUrlForLogs(normalizedUrl),
        status: response.status,
      })
      throw new EgressProxyError("request_failed", detail)
    }

    let outcome: z.infer<typeof ProxyOutcomeSchema>
    try {
      outcome = ProxyOutcomeSchema.parse(await response.json())
    } catch (err) {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
      const detail = err instanceof Error ? err.message : String(err)
      throw new EgressProxyError("invalid_response", detail)
    }

    clearTimeout(timer)
    callerSignal?.removeEventListener("abort", onCallerAbort)

    if (!outcome.ok) {
      throw new EgressProxyError(outcome.reason, outcome.detail)
    }

    const { result } = outcome
    try {
      return new Response(result.html, {
        status: result.status,
        headers: result.headers,
      })
    } catch {
      throw new EgressProxyError("invalid_response", "proxy response could not be constructed")
    }
  }
}
