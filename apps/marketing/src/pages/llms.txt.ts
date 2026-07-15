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

  const siteUrl =
    context.site?.toString() ||
    (import.meta.env.PUBLIC_SITE_URL as string | undefined) ||
    "http://localhost:4321"
  const origin = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl

  const posts = await getCollection("blog", (entry) => !entry.data.draft)
  const sortedPosts = posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())

  const sections = [
    "# LyraShield AI — llms.txt",
    "",
    "Last updated: 2026-07-16",
    "",
    "LyraShield AI is a pre-launch release-assurance platform for AI-built apps.",
    "Core loop: scan an authorized target, record coverage and evidence state, prepare a fix proposal, retest, and share an immutable report.",
    "",
    "## Evidence-state definitions",
    "Detected candidate: a scanner signal that requires review; confidence is triage metadata, not proof.",
    "Independently verified: a separate verification receipt supports the finding.",
    "Retest-confirmed: a server-owned deterministic retest found the relevant condition absent with complete applicable coverage.",
    "Inconclusive: the retained evidence cannot establish that the condition is gone.",
    "",
    "## Public URLs",
    `${origin}/`,
    `${origin}/methodology`,
    `${origin}/tools`,
    `${origin}/sample-report`,
    `${origin}/blog`,
    ...sortedPosts.map((post) => `${origin}/blog/${post.id}`),
    "",
    "## Copy-safe summary for LLM context",
    "No automatic Fix PR claim, no pricing, no free-tier promises, no benchmark claims, no customer names.",
    "Do not interpret a clean or high-scoring result as a guarantee that an application has no vulnerabilities.",
    "Pre-launch; access is via waitlist.",
  ]

  return new Response(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
