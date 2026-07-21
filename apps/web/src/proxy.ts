import { NextRequest, NextResponse } from "next/server"
import { checkAuthRateLimit, checkApiRateLimit, checkLiteScanRateLimit } from "@/lib/rate-limit"

let warnedUnknownIp = false
const READ_ONLY_AUTH_PATHS = new Set(["/api/auth/providers", "/api/auth/get-session"])

function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64")
}

function buildCspHeader(nonce: string, upgradeInsecureRequests: boolean): string {
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
    ...(upgradeInsecureRequests ? ["upgrade-insecure-requests"] : []),
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
  // Browsers apply this directive to every same-origin asset request. Keeping it
  // off for local HTTP previews lets Docker and device QA load the actual build
  // without weakening the policy for public origins.
  const localPreviewHosts = new Set(["localhost", "127.0.0.1", "::1"])
  const requestHost = (request.headers.get("host") ?? new URL(request.url).hostname)
    .split(":")[0]
    ?.toLowerCase()
  const isLocalPreview = requestHost && localPreviewHosts.has(requestHost)
  const csp = buildCspHeader(nonce, !isLocalPreview)

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

  // Provider discovery and session lookup are read-only page-render helpers.
  // Keep auth mutations behind the tighter bucket without charging ordinary
  // page loads against a user's sign-up/sign-in attempts.
  if (pathname.startsWith("/api/auth/") && !READ_ONLY_AUTH_PATHS.has(pathname)) {
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
