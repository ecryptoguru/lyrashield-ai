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

// Trailing-slash canonicalisation. wrangler.jsonc sets
// assets.html_handling to "none" so the platform layer performs NO
// built-in HTML handling (with the drop-trailing-slash default it
// canonicalised with a 307, which is not cacheable as permanently moved).
// Every canonical URL on this site is slash-less, so any request whose
// path ends in "/" (except the homepage itself) is redirected here with a
// permanent 301. This also covers direct asset-shaped requests
// ("/pricing/index.html") that html_handling "none" would otherwise 404
// per Cloudflare's docs table (workers-sdk#7422): with html_handling
// disabled, folder index files only resolve via their exact
// /folder/index.html form, which this canonicalisation redirects to the
// page route the Astro app manifest serves.
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

  // Trailing-slash and index.html canonicalisation (301). Must run before
  // next() so it wins over any remaining asset-layer behavior. Query and
  // hash are preserved (hash never reaches the server; query is reattached).
  const pathname = url.pathname
  const hasTrailingSlash = pathname.length > 1 && pathname.endsWith("/")
  const isIndexHtml = pathname.length > 1 && /\/index\.html$/.test(pathname)
  if (hasTrailingSlash || isIndexHtml) {
    let canonicalPath = pathname
    if (isIndexHtml) {
      // /pricing/index.html -> /pricing ; /blog/index.html -> /blog
      canonicalPath = pathname.replace(/\/index\.html$/, "")
    }
    canonicalPath = canonicalPath.replace(/\/+$/, "")
    if (canonicalPath === "") canonicalPath = "/"
    if (canonicalPath !== pathname) {
      const location = canonicalPath + url.search
      return new Response(null, {
        status: 301,
        headers: {
          Location: location,
          "Cache-Control": "public, max-age=31536000",
          "X-Robots-Tag": "noindex",
        },
      })
    }
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
