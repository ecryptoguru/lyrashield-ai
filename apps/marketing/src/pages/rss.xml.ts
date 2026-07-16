import type { APIRoute } from "astro"
import { getCollection } from "astro:content"
import rss from "@astrojs/rss"

export const prerender = false

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
  const posts = await getCollection("blog", (entry) => !entry.data.draft)
  const sortedPosts = posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())

  const items = sortedPosts.slice(0, 20).map((post) => ({
    title: post.data.title,
    description: post.data.description,
    link: `/blog/${post.id}`,
    pubDate: post.data.pubDate,
  }))

  return rss({
    title: "LyraShield AI Blog",
    description:
      "LyraShield AI research and practical guidance on securing AI-built apps, interpreting security evidence, verifying findings, and retesting fixes.",
    site: siteUrl,
    items,
    customData: `<language>en-us</language>`,
  })
}
