import { NextRequest, NextResponse } from "next/server"
import { isDev } from "@lyrashield/config"
import {
  checkAuthRateLimit,
  checkApiRateLimit,
  checkBillingWebhookRateLimit,
  checkHealthRateLimit,
  checkLiteScanRateLimit,
} from "@/lib/rate-limit"
import { detectAttribution, parseAffiliateCookie } from "@lyrashield/affiliate"
import { hasBillingStagingAccess } from "@/lib/billing-staging-access"
import { scorecardTrackingAllowed } from "@/lib/scorecard-sharing"
import { assessAppOrigin, isAppHost, trustedAppCountry } from "@/lib/app-origin"

// This is the Next.js 16 middleware entry. Next.js detects `proxy.ts` as the
// proxy/middleware file; do not create a separate `middleware.ts` or the build
// will fail with the `middleware-to-proxy` error.
//
// Affiliate attribution (S3/S4/S8) was merged from the former middleware.ts:
// ?ref= param and /r/:code short links are detected here, the IP is salted
// and SHA-256 hashed before storage, the user-agent is hashed, and the
// __ls_consent cookie is checked before setting the affiliate cookie.
// Note: proxy.ts always runs on the Node.js runtime in Next.js 16.

let warnedUnknownIp = false
const READ_ONLY_AUTH_PATHS = new Set(["/api/auth/providers", "/api/auth/get-session"])
const RATE_LIMIT_BYPASS_PATHS = new Set([
  "/api/health",
  "/api/ready",
  "/api/ready/evidence",
  "/api/ready/scans",
])
const BILLING_STAGING_PUBLIC_PATHS = new Set([
  "/staging/access",
  "/api/staging/access",
  "/billing/webhook",
  "/api/health",
  "/api/ready",
])

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary)
}

function buildCspHeader(nonce: string, upgradeInsecureRequests: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://checkout.razorpay.com${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com`,
    "font-src 'self'",
    `connect-src 'self' https://api.razorpay.com${isDev ? " ws:" : ""}`,
    "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
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
    // Proxy must remain edge-safe; use the platform logger rather than the Node logger package.
    console.warn(
      "client IP unavailable — TRUSTED_PROXY_IP_HEADER unset or header missing; rate limiting degraded to a shared bucket"
    )
    warnedUnknownIp = true
  }
  return "unknown"
}

/**
 * S3: Hash a value (IP or user-agent) with a server-side salt using Web Crypto.
 * Raw IPs and plaintext UAs are never persisted to the affiliate click store.
 */
async function hashWithSalt(value: string): Promise<string> {
  const salt = process.env.IP_HASH_SALT ?? "lyrashield-ip-salt-v1"
  const data = new TextEncoder().encode(value + salt)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * S3: Extract and hash the client IP for affiliate click storage.
 * Checks common proxy headers (cf-connecting-ip, true-client-ip, etc.).
 * Returns undefined if no IP header is found.
 */
async function getAffiliateIpHash(request: NextRequest): Promise<string | undefined> {
  const headers = ["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-forwarded-for"]
  for (const header of headers) {
    const value = request.headers.get(header)
    if (value) {
      const ip = value.split(",")[0]?.trim()
      if (ip) return hashWithSalt(ip)
    }
  }
  return undefined
}

/**
 * Handle affiliate attribution for non-API requests.
 * Detects ?ref= param or /r/:code short link, records the click, and
 * sets the __ls_aff cookie (subject to consent).
 *
 * Returns a NextResponse if the request should be redirected or short-circuited
 * (e.g. /r/:code redirect), or null to continue with normal proxy processing.
 */
async function handleAffiliateAttribution(
  request: NextRequest,
  requestHeaders: Headers,
  csp: string,
  isLocalPreview: boolean
): Promise<NextResponse | null> {
  const { pathname, searchParams } = request.nextUrl
  const host = request.headers.get("host") ?? ""

  // Subdomain rewrite: affiliates.lyrashieldai.com → /affiliates
  if (host === "affiliates.lyrashieldai.com" && !pathname.startsWith("/affiliates")) {
    const url = request.nextUrl.clone()
    url.pathname = `/affiliates${pathname === "/" ? "" : pathname}`
    return NextResponse.rewrite(url)
  }

  // Check for ref= param or /r/:code path
  const hasRef = searchParams.has("ref")
  const isShortLink = /^\/r\/[A-Za-z0-9_-]+$/.test(pathname)

  if (!hasRef && !isShortLink) {
    return null
  }

  const trackingAllowed = scorecardTrackingAllowed({
    doNotTrack: request.headers.get("dnt"),
    globalPrivacyControl: request.headers.get("sec-gpc") === "1",
  })
  if (!trackingAllowed) {
    if (!isShortLink) return null
    const response = NextResponse.redirect(new URL("/", request.url))
    response.headers.set("Content-Security-Policy", csp)
    return response
  }

  // Detect attribution
  const cookieToken = parseAffiliateCookie(request.headers.get("cookie"))
  const ipHash = await getAffiliateIpHash(request)
  const rawUserAgent = request.headers.get("user-agent") ?? undefined
  // S4: Hash the user-agent before storing — never store plaintext UA
  const userAgent = rawUserAgent ? await hashWithSalt(rawUserAgent) : undefined

  // S8: Check consent cookie — GDPR-compliant
  const consentCookie = request.cookies.get("__ls_consent")?.value
  const consentGiven = consentCookie === "true"

  const result = await detectAttribution({
    pathname,
    searchParams,
    landingUrl: request.url,
    referrer: request.headers.get("referer") ?? undefined,
    ipHash,
    userAgent,
    cookieToken,
    consentGiven,
  })

  // Handle redirect for /r/:code
  if (result.redirectUrl) {
    const redirectUrl = new URL(result.redirectUrl, request.url)
    const response = NextResponse.redirect(redirectUrl)
    if (result.setCookie) {
      response.headers.set("Set-Cookie", result.setCookie)
    }
    response.headers.set("Content-Security-Policy", csp)
    return response
  }

  // For ?ref= on a page — continue to the page but set cookie
  if (result.setCookie) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    response.headers.set("Set-Cookie", result.setCookie)
    response.headers.set("Content-Security-Policy", csp)
    if (!isLocalPreview) {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload"
      )
    }
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
  // Origin Pulls. Reject direct Azure traffic before any Redis-backed limiter;
  // do not let a caller manufacture either the client certificate or country.
  if (isAppHost(request)) {
    const originTrust = await assessAppOrigin(request)
    if (originTrust === "untrusted") {
      const response = new NextResponse(null, { status: 404 })
      response.headers.set("Cache-Control", "private, no-store")
      response.headers.set("Content-Security-Policy", csp)
      return response
    }
    const country = originTrust === "cloudflare" ? trustedAppCountry(request) : null
    requestHeaders.delete("cf-ipcountry")
    requestHeaders.delete("x-forwarded-client-cert")
    requestHeaders.delete("x-lyrashield-country")
    requestHeaders.delete("x-lyrashield-trusted-country")
    if (country) requestHeaders.set("x-lyrashield-trusted-country", country)
  }

  // The disposable billing-staging app keeps external ingress only because
  // sandbox/test providers must deliver signed webhooks. Protect every other
  // application route with a short-lived, HttpOnly same-origin session.
  if (
    process.env.LYRASHIELD_DEPLOYMENT_ENVIRONMENT === "billing-staging" &&
    !BILLING_STAGING_PUBLIC_PATHS.has(pathname) &&
    !pathname.startsWith("/_next/static/") &&
    !hasBillingStagingAccess(request)
  ) {
    const response = new NextResponse(null, { status: 404 })
    response.headers.set("Cache-Control", "private, no-store")
    response.headers.set("Content-Security-Policy", csp)
    return response
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
      response.headers.set("Content-Security-Policy", csp)
      if (!isLocalPreview) {
        response.headers.set(
          "Strict-Transport-Security",
          "max-age=63072000; includeSubDomains; preload"
        )
      }
      return response
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.headers.set("Content-Security-Policy", csp)
    response.headers.set("X-RateLimit-Remaining", String(result.remaining))
    if (!isLocalPreview) {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload"
      )
    }
    return response
  }

  if (!pathname.startsWith("/api/")) {
    // Affiliate attribution: detect ?ref= or /r/:code, record click, set cookie.
    // Returns a response if the request is redirected or has an affiliate cookie;
    // returns null to continue with normal CSP/HSTS response.
    const affiliateResponse = await handleAffiliateAttribution(
      request,
      requestHeaders,
      csp,
      isLocalPreview
    )
    if (affiliateResponse) {
      return affiliateResponse
    }

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    })
    response.headers.set("Content-Security-Policy", csp)
    if (!isLocalPreview) {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload"
      )
    }
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
      response.headers.set("Content-Security-Policy", csp)
      return response
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.headers.set("Content-Security-Policy", csp)
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
  matcher: ["/:path*"],
}
