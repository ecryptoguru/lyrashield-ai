import { defineMiddleware } from "astro:middleware"

const SECURITY_HEADERS = {
  "Origin-Agent-Cluster": "?1",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://pulse.lyrashieldai.com https://us.i.posthog.com https://us-assets.i.posthog.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' blob: https://media.lyrashieldai.com; connect-src 'self' https: https://cloudflareinsights.com https://media.lyrashieldai.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "tools=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const

// Permanent 301 redirects — handled in middleware so Cloudflare Workers
// returns a true 301 instead of a meta-refresh HTML page (which is all
// Astro static output can generate from Astro.redirect()).
const PERMANENT_REDIRECTS: Record<string, string> = {
  "/docs": "/docs/integrations",
  "/resources": "/blog",
  "/how-it-works": "/#how-it-works",
  "/docs/integrations/windsurf": "/docs/integrations/devin",
  "/sitemap.xml": "/sitemap-index.xml",
}

// NOTE: trailing-slash and /index.html canonicalisation lives in
// src/fetch.ts (the Astro 7 advanced-routing entrypoint), NOT here —
// Astro middleware never runs for prerendered pages, so it cannot see
// /pricing/ style requests. This middleware handles the SSR API routes:
// the permanent redirects below and the security headers for every
// response that does flow through Astro's pipeline.
export const onRequest = defineMiddleware(async ({ url }, next) => {
  const redirectTarget = PERMANENT_REDIRECTS[url.pathname]
  if (redirectTarget) {
    return new Response(null, {
      status: 301,
      headers: {
        Location: redirectTarget,
        "Cache-Control": "public, max-age=31536000",
        "X-Robots-Tag": "noindex",
      },
    })
  }

  const response = await next()
  const headers = new Headers(response.headers)

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    const isCsp = name === "Content-Security-Policy"
    const shouldUpgrade = url.protocol === "https:"
    headers.set(
      name,
      isCsp && !shouldUpgrade ? value.replace("; upgrade-insecure-requests", "") : value
    )
  }

  if (url.pathname.startsWith("/api/")) {
    headers.set("Cache-Control", "no-store")
    headers.set("X-Robots-Tag", "noindex")
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
})
