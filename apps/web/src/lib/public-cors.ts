/**
 * Origin-checked CORS for unauthenticated, read-only public endpoints that the
 * marketing site (and this app itself) may call cross-origin. Only the
 * configured marketing/app origins receive CORS headers; every other origin
 * gets none, so browsers keep the response opaque to them.
 */

const ALLOWED_METHODS = "GET, POST, OPTIONS"

function trustedOrigins(): Set<string> {
  const values = [process.env.NEXT_PUBLIC_MARKETING_URL, process.env.NEXT_PUBLIC_APP_URL]
  return new Set(
    values.flatMap((value) => {
      if (!value) return []
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    })
  )
}

export function isPublicOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin")
  return origin ? trustedOrigins().has(origin) : false
}

export function publicCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin")
  if (!origin || !trustedOrigins().has(origin)) return {}
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  }
}

export function publicResponse(request: Request, body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      ...publicCorsHeaders(request),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

export function publicPreflight(request: Request): Response {
  if (!isPublicOriginAllowed(request)) return publicResponse(request, { error: "forbidden" }, 403)
  return new Response(null, { status: 204, headers: publicCorsHeaders(request) })
}
