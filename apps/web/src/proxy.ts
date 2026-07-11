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

// IMPORTANT: This function prioritizes trusted proxy headers and the last hop
// in x-forwarded-for (the closest proxy). If the proxy does not strip/spoof-safe
// the forwarded header, prefer a provider-specific header like cf-connecting-ip
// or true-client-ip, which is harder to forge.
function getClientIP(request: NextRequest): string {
  const providerIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("true-client-ip") ??
    request.headers.get("x-real-ip")
  if (providerIp) return providerIp.trim()

  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    // In a chain, the last address is the one most recently appended by the
    // closest trusted proxy, which is less spoofable than the first (client) entry.
    const parts = forwarded.split(",")
    return parts[parts.length - 1]!.trim()
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
