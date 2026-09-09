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
