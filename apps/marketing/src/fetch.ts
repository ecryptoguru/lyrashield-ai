import { astro, type FetchState } from "astro/fetch"

/**
 * Advanced-routing entrypoint (Astro 7: enabled by default, src/fetch.ts is
 * reserved). This pipeline runs for EVERY request the Worker receives —
 * including prerendered pages, which Astro middleware never sees (middleware
 * is skipped for statically rendered routes. The platform's
 * drop-trailing-slash handling only applies at the asset layer).
 *
 * Why this file exists: /pricing/ used to 307 at the platform asset layer.
 * With run_worker_first the Worker sees every request first, but Astro's
 * built-in pipeline normalizes the URL and serves the page (200) without a
 * redirect while src/middleware.ts never runs for prerendered routes. This
 * entrypoint is the one place that can canonicalise BEFORE Astro touches
 * the request.
 *
 * Every canonical URL on this site is slash-less (trailingSlash: "never"),
 * so a request whose path ends in "/" — except "/" itself — is permanently
 * redirected to the slash-less form. /index.html forms canonicalise the
 * same way. Query strings are preserved. Everything else runs Astro's full
 * built-in pipeline unchanged via the astro() handler.
 */

const permanentRedirectHeaders: HeadersInit = {
  "Cache-Control": "public, max-age=31536000",
  "X-Robots-Tag": "noindex",
}

function canonicalise(pathname: string, search: string): string | undefined {
  if (pathname.length <= 1) return undefined
  const hasTrailingSlash = pathname.endsWith("/")
  const isIndexHtml = /\/index\.html$/.test(pathname)
  if (!hasTrailingSlash && !isIndexHtml) return undefined
  let canonical = pathname
  if (isIndexHtml) canonical = canonical.replace(/\/index\.html$/, "")
  canonical = canonical.replace(/\/+$/, "")
  if (canonical === "" || canonical === pathname) return undefined
  return canonical + search
}

const pipeline = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const location = canonicalise(url.pathname, url.search)
    if (location) {
      return new Response(null, {
        status: 301,
        headers: { Location: location, ...permanentRedirectHeaders },
      })
    }
    return astro(new FetchState(request))
  },
}

export default pipeline
