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

  // Answer engines are welcomed explicitly. Relying on the permissive wildcard means a
  // future tightening of `*` would silently revoke access for the crawlers this product
  // most wants to be cited by.
  const aiCrawlers = ["GPTBot", "ClaudeBot", "PerplexityBot", "CCBot", "Google-Extended"]
  const aiStanzas = aiCrawlers.map((agent) => `User-agent: ${agent}\nDisallow:\n`).join("")

  return new Response(
    `User-agent: *\nDisallow:\n\n${aiStanzas}\nSitemap: ${siteOrigin}/sitemap-index.xml\n`,
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }
  )
}
