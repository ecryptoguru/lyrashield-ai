import type { APIRoute } from "astro"
import { getCollection } from "astro:content"

export const prerender = false

export const GET: APIRoute = async (context) => {
  const indexable = __MARKETING_INDEXABLE__

  // Not live yet: don't publish a crawlable/citable summary of an unlaunched
  // preview build. Matches the noindex/robots.txt gating used everywhere else.
  if (!indexable) {
    return new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  const siteUrl = context.site?.toString() || (import.meta.env.PUBLIC_SITE_URL as string | undefined) || "http://localhost:4321"
  const origin = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl

  const posts = await getCollection("blog", (entry) => !entry.data.draft)
  const sortedPosts = posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())

  const sections = [
    "# LyraSec AI — llms.txt",
    "",
    "LyraSec AI is an AI security agent for AI-built apps.",
    "Core loop: scan a target, verify findings, open a fix PR, retest, and share a report.",
    "",
    "## Public URLs",
    `${origin}/`,
    `${origin}/blog`,
    ...sortedPosts.map((post) => `${origin}/blog/${post.id}`),
    "",
    "## Copy-safe summary for LLM context",
    "No pricing, no free-tier promises, no benchmark claims, no customer names.",
    "Pre-launch; access is via waitlist.",
  ]

  return new Response(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
