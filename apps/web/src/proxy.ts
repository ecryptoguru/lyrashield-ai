import { NextRequest, NextResponse } from "next/server"
import { checkAuthRateLimit, checkApiRateLimit, checkLiteScanRateLimit } from "@/lib/rate-limit"

let warnedUnknownIp = false

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
  if (!trustedHeader) return warnUnknownIp()

  const value = request.headers.get(trustedHeader)
  if (!value) return warnUnknownIp()

  const parts = value.split(",")
  return parts[parts.length - 1]!.trim() || warnUnknownIp()
}

function warnUnknownIp(): "unknown" {
  if (!warnedUnknownIp) {
    // Middleware must remain edge-safe; use the platform logger rather than the Node logger package.
    console.warn(
      "client IP unavailable — TRUSTED_PROXY_IP_HEADER unset or header missing; rate limiting degraded to a shared bucket"
    )
    warnedUnknownIp = true
  }
  return "unknown"
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
    if (
      pathname.startsWith("/score/") ||
      pathname.startsWith("/lite-check/") ||
      pathname.startsWith("/reports/shared/")
    )
      response.headers.set("Referrer-Policy", "no-referrer")
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

  const rateLimitKey =
    pathname === "/api/lite-scan"
      ? Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)))
        )
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")
      : ip
  const result =
    pathname === "/api/lite-scan"
      ? await checkLiteScanRateLimit(rateLimitKey)
      : await checkApiRateLimit(rateLimitKey)
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
