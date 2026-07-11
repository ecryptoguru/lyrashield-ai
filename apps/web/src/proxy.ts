import { NextRequest, NextResponse } from "next/server"
import { checkAuthRateLimit, checkApiRateLimit } from "@/lib/rate-limit"

function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64")
}

function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development"
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com`,
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ]
  return directives.join("; ")
}

export function getClientIP(request: NextRequest): string {
  const trustedHeader = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase()
  if (!trustedHeader) return "unknown"

  const value = request.headers.get(trustedHeader)
  if (!value) return "unknown"

  const parts = value.split(",")
  return parts[parts.length - 1]!.trim() || "unknown"
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const nonce = generateNonce()
  const csp = buildCspHeader(nonce)

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)

  if (!pathname.startsWith("/api/")) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    response.headers.set("Content-Security-Policy", csp)
    return response
  }

  const ip = getClientIP(request)

  if (pathname.startsWith("/api/auth/")) {
    const result = await checkAuthRateLimit(ip)
    if (result.limited) {
      const response = NextResponse.json(
        {
          success: false,
          error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfter),
            "X-RateLimit-Remaining": "0",
          },
        }
      )
      response.headers.set("Content-Security-Policy", csp)
      return response
    }
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    response.headers.set("Content-Security-Policy", csp)
    response.headers.set("X-RateLimit-Remaining", String(result.remaining))
    return response
  }

  const result = await checkApiRateLimit(ip)
  if (result.limited) {
    const response = NextResponse.json(
      {
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfter),
          "X-RateLimit-Remaining": "0",
        },
      }
    )
    response.headers.set("Content-Security-Policy", csp)
    return response
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  response.headers.set("Content-Security-Policy", csp)
  response.headers.set("X-RateLimit-Remaining", String(result.remaining))
  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
