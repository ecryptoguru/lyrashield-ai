const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
const OAUTH_PROTOCOL_PATH_PREFIX = "/api/auth/oauth2/"

export const OAUTH_RATE_LIMIT_ERROR = {
  error: "temporarily_unavailable",
  error_description: "Too many requests. Please try again later.",
} as const

export function isOAuthProtocolPath(pathname: string): boolean {
  return pathname.startsWith(OAUTH_PROTOCOL_PATH_PREFIX)
}

export async function normalizeOAuthRateLimitResponse(response: Response): Promise<Response> {
  if (response.status !== 429) return response

  const headers = new Headers(response.headers)
  headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(OAUTH_RATE_LIMIT_ERROR), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Some installed desktop clients omit `application_type` or send `web` while
 * supplying the public-client loopback callback required for a native client.
 * Classify that exact combination as native; all other redirect metadata remains
 * subject to the OAuth provider's validation.
 */
export function normalizeLoopbackOAuthClient(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const client = body as Record<string, unknown>
  if (
    (client.application_type !== undefined && client.application_type !== "web") ||
    !Array.isArray(client.redirect_uris)
  )
    return body
  if (client.redirect_uris.length === 0) return body
  if (client.token_endpoint_auth_method !== "none") return body

  const onlyNativeLoopbacks = client.redirect_uris.every((value) => {
    if (typeof value !== "string") return false
    try {
      const url = new URL(value)
      return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
    } catch {
      return false
    }
  })

  return onlyNativeLoopbacks ? { ...client, application_type: "native" } : body
}
