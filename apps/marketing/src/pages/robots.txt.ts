import type { APIRoute } from "astro"

export const GET: APIRoute = async () => {
  const indexable = (import.meta.env.PUBLIC_INDEXABLE as string | undefined) === "true"

  if (!indexable) {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  const siteUrl = (import.meta.env.PUBLIC_SITE_URL as string | undefined) || "http://localhost:4321"
  const siteOrigin = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl

  return new Response(
    `User-agent: *\nDisallow:\nSitemap: ${siteOrigin}/sitemap-index.xml\n`,
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }
  )
}
