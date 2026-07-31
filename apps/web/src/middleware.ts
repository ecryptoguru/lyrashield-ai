import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { checkApiRateLimit } from "./lib/rate-limit"

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next()
  }

  const forwarded = request.headers.get("x-forwarded-for")
  const ip = forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "unknown"

  const rate = await checkApiRateLimit(ip)
  if (rate.limited) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: {
        "Content-Type": "text/plain",
        "Retry-After": String(rate.retryAfter),
        "X-RateLimit-Remaining": "0",
      },
    })
  }

  const response = NextResponse.next()
  response.headers.set("X-RateLimit-Remaining", String(rate.remaining))
  return response
}

export const config = {
  matcher: ["/api/:path*"],
}
