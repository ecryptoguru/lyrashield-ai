import type { APIRoute } from "astro"

export const GET: APIRoute = async (context) => {
  const indexable = __MARKETING_INDEXABLE__

  if (!indexable) {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  const siteUrl = context.site?.toString() || "http://localhost:4321"
  const siteOrigin = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl

  return new Response(`User-agent: *\nDisallow:\nSitemap: ${siteOrigin}/sitemap-index.xml\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
