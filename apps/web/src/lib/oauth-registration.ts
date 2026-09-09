const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Some installed desktop clients register as `web` while supplying the loopback
 * callback required for a native public client. Classify that exact combination
 * as native; all other redirect metadata remains subject to the OAuth provider's
 * validation.
 */
export function normalizeLoopbackOAuthClient(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const client = body as Record<string, unknown>
  if (client.application_type !== "web" || !Array.isArray(client.redirect_uris)) return body
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
