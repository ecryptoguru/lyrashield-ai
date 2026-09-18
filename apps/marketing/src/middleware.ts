import { defineMiddleware } from "astro:middleware"

const SECURITY_HEADERS = {
  "Origin-Agent-Cluster": "?1",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://us.i.posthog.com https://us-assets.i.posthog.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' blob: https://media.lyrashieldai.com; connect-src 'self' https: https://cloudflareinsights.com https://media.lyrashieldai.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
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
  // /blog/1 is not a generated route (page 1 IS /blog). The asset-layer
  // rules canonicalise /blog/1/ to /blog/1, which used to 404; send both to
  // the real hub instead of leaving a dead end for a URL people type.
  "/blog/1": "/blog",
}

// NOTE: trailing-slash and /index.html canonicalisation for prerendered
// pages lives in public/_redirects (the Workers asset-layer routing
// rules), NOT here — Astro middleware never runs for statically rendered
// pages and the worker's matchStaticAsset short-circuits the pipeline for
// them. This middleware handles the SSR API routes: the permanent
// redirects below and the security headers for every response that does
// flow through Astro's pipeline.
export const onRequest = defineMiddleware(async ({ url }, next) => {
  // VULN-P-001: SSR/API routes must also refuse plaintext — the static-page
  // path is covered by the worker-entry guard applied in postbuild
  // (scripts/apply-worker-scheme-guard.mjs); middleware never runs for it.
  //
  // `wrangler dev` serves the production build over plain http on loopback but
  // rewrites the request host to the custom domain, so a local request is
  // indistinguishable from a plaintext production one by URL alone. The
  // `pnpm preview` build therefore sets __MARKETING_LOCAL_PREVIEW__ (see
  // astro.config.mjs); without this exemption every SSR route (llms.txt,
  // rss.xml, agents.md, /api/*) answered 301 to https://127.0.0.1:8787, where
  // nothing listens, which also made the built-HTML SEO gate unable to read
  // the machine-readable surfaces. Production never sets the flag, and the
  // worker-entry guard still 301s plaintext there, so this only stands down
  // the redundant second layer.
  if (
    !__MARKETING_LOCAL_PREVIEW__ &&
    url.protocol === "http:" &&
    url.hostname.endsWith("lyrashieldai.com")
  ) {
    const https = new URL(url)
    https.protocol = "https:"
    return new Response(null, {
      status: 301,
      headers: {
        Location: https.toString(),
        "X-Robots-Tag": "noindex",
      },
    })
  }

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
