import { NextRequest, NextResponse } from "next/server"
import { checkAuthRateLimit, checkApiRateLimit } from "@/lib/rate-limit"

function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    return forwarded.split(",")[0]!.trim()
  }
  const realIP = request.headers.get("x-real-ip")
  if (realIP) return realIP
  return "unknown"
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (!pathname.startsWith("/api/")) {
    return NextResponse.next()
  }

  const ip = getClientIP(request)

  if (pathname.startsWith("/api/auth/")) {
    const result = await checkAuthRateLimit(ip)
    if (result.limited) {
      return NextResponse.json(
        { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfter),
            "X-RateLimit-Remaining": "0",
          },
        }
      )
    }
    const response = NextResponse.next()
    response.headers.set("X-RateLimit-Remaining", String(result.remaining))
    return response
  }

  const result = await checkApiRateLimit(ip)
  if (result.limited) {
    return NextResponse.json(
      { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfter),
          "X-RateLimit-Remaining": "0",
        },
      }
    )
  }

  const response = NextResponse.next()
  response.headers.set("X-RateLimit-Remaining", String(result.remaining))
  return response
}

export const config = {
  matcher: ["/api/:path*"],
}
