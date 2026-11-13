import { clearOptionalTrackingCookies } from "@/lib/analytics-cookies"
import {
  isPublicOriginAllowed,
  publicCorsHeaders,
  publicPreflight,
  publicResponse,
} from "@/lib/public-cors"

export function OPTIONS(request: Request): Response {
  return publicPreflight(request)
}

export function POST(request: Request): Response {
  if (!isPublicOriginAllowed(request)) return publicResponse(request, { error: "forbidden" }, 403)

  const response = new Response(null, {
    status: 204,
    headers: {
      ...publicCorsHeaders(request),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
  clearOptionalTrackingCookies(response, request)
  return response
}
