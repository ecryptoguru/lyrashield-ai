import { defineMiddleware } from "astro:middleware"

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://us.i.posthog.com https://us-assets.i.posthog.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const

export const onRequest = defineMiddleware(async ({ url }, next) => {
  const response = await next()
  const headers = new Headers(response.headers)

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
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
