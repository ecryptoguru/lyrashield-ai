import { logger } from "@lyrashield/logger"
import { EgressProxyError, type SafeFetchOutcome } from "./safe-fetch"
import { redactUrlForLogs } from "./ssrf"

interface ProxyFetchInit extends RequestInit {
  timeoutMs?: number
  maxBytes?: number
}

export interface EgressProxyFetchFnOptions {
  url: string
  secret: string
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
  const { url: baseUrl, secret } = options
  if (!baseUrl || !secret) return undefined

  const proxyUrl = new URL("/v1/fetch", baseUrl).toString()

  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const normalizedUrl =
      input instanceof Request ? input.url : typeof input === "string" ? input : input.toString()

    const proxyInit = init as ProxyFetchInit
    const timeoutMs = proxyInit.timeoutMs
    const maxBytes = proxyInit.maxBytes
    const proxyHeaders = new Headers(init.headers)
    const userAgent = proxyHeaders.get("user-agent") ?? undefined

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
        signal: init.signal,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.warn("egress proxy request failed", {
        url: redactUrlForLogs(normalizedUrl),
        error: detail,
      })
      throw new EgressProxyError("request_failed", detail)
    }

    if (!response.ok) {
      const detail = `Proxy returned HTTP ${response.status}`
      logger.warn("egress proxy returned failure status", {
        url: redactUrlForLogs(normalizedUrl),
        status: response.status,
      })
      throw new EgressProxyError("request_failed", detail)
    }

    let outcome: SafeFetchOutcome
    try {
      outcome = (await response.json()) as SafeFetchOutcome
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new EgressProxyError("invalid_response", detail)
    }

    if (!outcome.ok) {
      throw new EgressProxyError(outcome.reason, outcome.detail)
    }

    const { result } = outcome
    return new Response(result.html, {
      status: result.status,
      headers: result.headers,
    })
  }
}
