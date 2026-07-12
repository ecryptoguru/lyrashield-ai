import type { APIRoute } from "astro"
import { getCollection } from "astro:content"
import rss from "@astrojs/rss"

export const GET: APIRoute = async (context) => {
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
    title: "LyraSec AI Blog",
    description: "Posts on AI-built app security, verification, and the LyraSec AI approach.",
    site: siteUrl,
    items,
    customData: `<language>en-us</language>`,
  })
}
