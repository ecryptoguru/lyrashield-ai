import type { APIRoute } from "astro"
import { getCollection } from "astro:content"
import rss from "@astrojs/rss"
import { isNotAfterBuildDate } from "../lib/blog-publishing"

// This is build-derived content. Prerender it so the Worker does not rebuild
// the blog collection on each feed request.
export const prerender = true

export const GET: APIRoute = async (context) => {
  if (!__MARKETING_INDEXABLE__) {
    return new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  const siteUrl =
    context.site?.toString() ||
    (import.meta.env.PUBLIC_SITE_URL as string | undefined) ||
    "http://localhost:4321"
  const origin = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl
  const feedUrl = `${origin}/rss.xml`
  const posts = await getCollection(
    "blog",
    (entry) => !entry.data.draft && isNotAfterBuildDate(entry.data)
  )
  const sortedPosts = posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())

  const items = sortedPosts.slice(0, 20).map((post) => ({
    title: post.data.title,
    description: post.data.description,
    link: `/blog/${post.id}`,
    pubDate: post.data.pubDate,
  }))

  // Every canonical URL on this site is slash-less (see astro.config.mjs's
  // trailingSlash and public/_redirects). @astrojs/rss defaults trailingSlash
  // to true, which made every feed link a 301 hop to the canonical form.
  const lastBuildDate = sortedPosts.reduce<Date | undefined>((latest, post) => {
    const date = post.data.updatedDate ?? post.data.pubDate
    return latest && latest >= date ? latest : date
  }, undefined)

  const response = await rss({
    title: "LyraShield AI Blog",
    description:
      "LyraShield AI research and practical guidance on securing AI-built apps, interpreting security evidence, verifying findings and retesting fixes.",
    site: siteUrl,
    trailingSlash: false,
    items,
    customData:
      `<language>en-us</language>` +
      `<atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />` +
      (lastBuildDate ? `<lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>` : ""),
    xmlns: { atom: "http://www.w3.org/2005/Atom" },
  })
  // Same caching as agents.md — the feed only changes on deploys.
  response.headers.set("Cache-Control", "public, max-age=3600")
  return response
}
