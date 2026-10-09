import { NextRequest, NextResponse } from "next/server"
import { isDev } from "@lyrashield/config"
import {
  checkAuthRateLimit,
  checkApiRateLimit,
  checkBillingWebhookRateLimit,
  checkHealthRateLimit,
  checkLiteScanRateLimit,
} from "@/lib/rate-limit"
import { assessAppOrigin, isAppHost, isDirectAppOrigin, trustedAppCountry } from "@/lib/app-origin"
import { isOAuthProtocolPath, OAUTH_RATE_LIMIT_ERROR } from "@/lib/oauth-registration"

// This is the Next.js 16 middleware entry. Next.js detects `proxy.ts` as the
// proxy/middleware file; do not create a separate `middleware.ts` or the build
// will fail with the `middleware-to-proxy` error.
//
// Affiliate referral routing lives here: the affiliates.lyrashieldai.com
// subdomain rewrite and the /r/:code short link. New affiliate admission is
// frozen for launch, so no click is recorded and no __ls_aff attribution
// cookie is set on any path.
// Note: proxy.ts always runs on the Node.js runtime in Next.js 16.

let warnedUnknownIp = false
const READ_ONLY_AUTH_PATHS = new Set(["/api/auth/providers", "/api/auth/get-session"])
const RATE_LIMIT_BYPASS_PATHS = new Set([
  "/api/health",
  "/api/ready",
  "/api/ready/evidence",
  "/api/ready/scans",
])

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary)
}

function browserSentryConnectOrigin(dsn: string | undefined): string | null {
  if (!dsn) return null

  try {
    const url = new URL(dsn)
    if (
      url.protocol !== "https:" ||
      !url.username ||
      url.password ||
      url.pathname === "/" ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

function buildCspHeader(nonce: string, upgradeInsecureRequests: boolean): string {
  const sentryOrigin = browserSentryConnectOrigin(process.env.NEXT_PUBLIC_SENTRY_DSN)
  const connectSources = [
    "'self'",
    "https://api.razorpay.com",
    "https://us.i.posthog.com",
    "https://us-assets.i.posthog.com",
    ...(sentryOrigin ? [sentryOrigin] : []),
    ...(isDev ? ["ws:"] : []),
  ]
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://checkout.razorpay.com https://us-assets.i.posthog.com${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com`,
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
    "object-src 'none'",
    // Pin the directives default-src would otherwise inherit so a future
    // default-src change cannot silently widen worker/media/manifest loads.
    "worker-src 'self'",
    "media-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(upgradeInsecureRequests ? ["upgrade-insecure-requests"] : []),
  ]
  return directives.join("; ")
}

const HSTS_HEADER = "max-age=63072000; includeSubDomains; preload"

/**
 * Every response the proxy produces — page pass-throughs, rewrites,
 * redirects, and early-return errors — carries the same CSP/HSTS posture.
 * Centralizing it keeps a new response path from ever shipping bare.
 */
function applySecurityHeaders(response: NextResponse, csp: string, isLocalPreview: boolean): void {
  response.headers.set("Content-Security-Policy", csp)
  if (!isLocalPreview) {
    response.headers.set("Strict-Transport-Security", HSTS_HEADER)
  }
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
    // Proxy must remain edge-safe; use the platform logger rather than the Node logger package.
    console.warn(
      "client IP unavailable — TRUSTED_PROXY_IP_HEADER unset or header missing; rate limiting degraded to a shared bucket"
    )
    warnedUnknownIp = true
  }
  return "unknown"
}

/**
 * Handle affiliate referral routing for non-API requests.
 *
 * New affiliate admission is frozen for launch, so this no longer detects
 * ?ref=, records a Click, creates an AttributionToken or sets the __ls_aff
 * cookie. What remains is the routing that must keep working:
 *
 *  - the affiliates.lyrashieldai.com subdomain rewrite, so the affiliate pages
 *    stay reachable;
 *  - the /r/:code short link redirect, so previously shared links do not 404.
 *    The redirect target is the homepage and it carries no attribution.
 *
 * Returns a NextResponse when the request was rewritten or redirected, or null
 * to continue with normal proxy processing.
 */
async function handleAffiliateRouting(
  request: NextRequest,
  csp: string,
  isLocalPreview: boolean
): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl
  const host = request.headers.get("host") ?? ""

  // Subdomain rewrite: affiliates.lyrashieldai.com → /affiliates
  if (host === "affiliates.lyrashieldai.com" && !pathname.startsWith("/affiliates")) {
    const url = request.nextUrl.clone()
    url.pathname = `/affiliates${pathname === "/" ? "" : pathname}`
    const response = NextResponse.rewrite(url)
    applySecurityHeaders(response, csp, isLocalPreview)
    return response
  }

  // /r/:code short link: redirect to the homepage without attribution.
  if (/^\/r\/[A-Za-z0-9_-]+$/.test(pathname)) {
    const response = NextResponse.redirect(new URL("/", request.url))
    applySecurityHeaders(response, csp, isLocalPreview)
    return response
  }

  return null
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
  const isLocalPreview = Boolean(requestHost && localPreviewHosts.has(requestHost))
  const csp = buildCspHeader(nonce, !isLocalPreview)

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)

  // Only Cloudflare's app hostname is configured with per-host Authenticated
  // Origin Pulls. A direct candidate may pass only with this deployment's
  // short-lived, exact client certificate; all other direct traffic is denied
  // before any Redis-backed limiter.
  const originTrust = await assessAppOrigin(request)
  if (isDirectAppOrigin(request) && originTrust !== "probe") {
    const response = new NextResponse(null, { status: 404 })
    response.headers.set("Cache-Control", "private, no-store")
    applySecurityHeaders(response, csp, isLocalPreview)
    return response
  }

  if (isAppHost(request)) {
    if (originTrust === "untrusted") {
      const response = new NextResponse(null, { status: 404 })
      response.headers.set("Cache-Control", "private, no-store")
      applySecurityHeaders(response, csp, isLocalPreview)
      return response
    }
    const country = originTrust === "cloudflare" ? trustedAppCountry(request) : null
    requestHeaders.delete("cf-ipcountry")
    requestHeaders.delete("x-forwarded-client-cert")
    requestHeaders.delete("x-lyrashield-country")
    requestHeaders.delete("x-lyrashield-trusted-country")
    if (country) requestHeaders.set("x-lyrashield-trusted-country", country)
  }

  if (pathname === "/billing/webhook") {
    const result = await checkBillingWebhookRateLimit(getClientIP(request))
    if (result.limited) {
      const response = NextResponse.json(
        {
          success: false,
          error: { code: "RATE_LIMITED", message: "Too many webhook requests." },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfter),
            "X-RateLimit-Remaining": "0",
          },
        }
      )
      applySecurityHeaders(response, csp, isLocalPreview)
      return response
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    applySecurityHeaders(response, csp, isLocalPreview)
    response.headers.set("X-RateLimit-Remaining", String(result.remaining))
    return response
  }

  if (!pathname.startsWith("/api/")) {
    // Affiliate referral routing: the affiliates subdomain rewrite and the
    // /r/:code short link. No click is recorded and no attribution cookie is
    // set while new admission is frozen.
    const affiliateResponse = await handleAffiliateRouting(request, csp, isLocalPreview)
    if (affiliateResponse) {
      return affiliateResponse
    }

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    applySecurityHeaders(response, csp, isLocalPreview)
    if (
      pathname.startsWith("/score/") ||
      pathname.startsWith("/lite-check/") ||
      pathname.startsWith("/reports/shared/") ||
      pathname === "/licenses/retrieve"
    )
      response.headers.set("Referrer-Policy", "no-referrer")
    if (pathname === "/licenses/retrieve")
      response.headers.set("Cache-Control", "private, no-store")
    return response
  }

  // Readiness endpoints already perform their own dependency checks. Charging
  // health probes against shared client buckets wastes Redis commands and can
  // hide the dependency state the probes exist to report.
  if (RATE_LIMIT_BYPASS_PATHS.has(pathname)) {
    const result = checkHealthRateLimit(getClientIP(request))
    if (result.limited) {
      const response = NextResponse.json(
        {
          success: false,
          error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
        },
        { status: 429, headers: { "Retry-After": String(result.retryAfter) } }
      )
      applySecurityHeaders(response, csp, isLocalPreview)
      return response
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    applySecurityHeaders(response, csp, isLocalPreview)
    response.headers.set("X-RateLimit-Remaining", String(result.remaining))
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
        isOAuthProtocolPath(pathname)
          ? OAUTH_RATE_LIMIT_ERROR
          : {
              success: false,
              error: {
                code: "RATE_LIMITED",
                message: "Too many requests. Please try again later.",
              },
            },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfter),
            "X-RateLimit-Remaining": "0",
          },
        }
      )
      applySecurityHeaders(response, csp, isLocalPreview)
      return response
    }
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    applySecurityHeaders(response, csp, isLocalPreview)
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
    applySecurityHeaders(response, csp, isLocalPreview)
    return response
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  applySecurityHeaders(response, csp, isLocalPreview)
  response.headers.set("X-RateLimit-Remaining", String(result.remaining))
  return response
}

export const config = {
  matcher: ["/:path*"],
}
