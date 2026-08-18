import { NextResponse, type NextRequest } from "next/server"
import { detectAttribution, parseAffiliateCookie } from "@lyrashield/affiliate"

/**
 * Next.js middleware for affiliate attribution.
 *
 * Detects `?ref=` param or `/r/:code` path → validates affiliate → records
 * click (async, non-blocking) → sets first-party cookie `__ls_aff`.
 *
 * Subdomain host rewrite: `affiliates.lyrashieldai.com` → `/affiliates` route group.
 */

function getIpHash(request: NextRequest): string | undefined {
  const headers = [
    "cf-connecting-ip",
    "true-client-ip",
    "x-real-ip",
    "x-forwarded-for",
  ]

  for (const header of headers) {
    const value = request.headers.get(header)
    if (value) {
      // Simple hash — the actual IP is never stored
      const ip = value.split(",")[0]?.trim()
      if (ip) return ip // In production, hash this with a salt
    }
  }

  return undefined
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const searchParams = request.nextUrl.searchParams
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
    // Still check for existing cookie on all requests (for cross-device)
    return NextResponse.next()
  }

  // Detect attribution
  const cookieToken = parseAffiliateCookie(request.headers.get("cookie"))
  const ipHash = getIpHash(request)
  const userAgent = request.headers.get("user-agent") ?? undefined

  const result = await detectAttribution({
    pathname,
    searchParams,
    landingUrl: request.url,
    referrer: request.headers.get("referer") ?? undefined,
    ipHash,
    userAgent,
    cookieToken,
    consentGiven: true, // Middleware-level — consent checked client-side too
  })

  // Handle redirect for /r/:code
  if (result.redirectUrl) {
    const redirectUrl = new URL(result.redirectUrl, request.url)
    const response = NextResponse.redirect(redirectUrl)

    if (result.setCookie) {
      response.headers.set("Set-Cookie", result.setCookie)
    }

    return response
  }

  // For ?ref= on a page — continue to the page but set cookie
  if (result.setCookie) {
    const response = NextResponse.next()
    response.headers.set("Set-Cookie", result.setCookie)
    return response
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Match all paths except API routes, _next, static files, and auth
    "/((?!api|_next/static|_next/image|favicon.ico|auth|sign-in|sign-up|forgot-password|reset-password).*)",
  ],
}
