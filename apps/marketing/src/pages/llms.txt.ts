import type { APIRoute } from "astro"
import { getCollection, getEntry } from "astro:content"

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
  const postRecords = await Promise.all(
    sortedPosts.map(async (post) => ({ post, image: await getEntry(post.data.heroImage) }))
  )

  const sections = [
    "# LyraShield AI — llms.txt",
    "",
    "Last updated: 2026-07-17",
    "",
    "LyraShield AI is a pre-launch release-assurance platform for AI-built apps.",
    "Core loop: scan an authorized target, record coverage and evidence state, prepare a fix proposal, retest, and share an immutable report.",
    "",
    "## Evidence-state definitions",
    "Detected candidate: a scanner signal that requires review; confidence is triage metadata, not proof.",
    "Independently verified: a separate verification receipt supports the finding.",
    "Retest-confirmed: a server-owned deterministic retest found the relevant condition absent with complete applicable coverage.",
    "Inconclusive: the retained evidence cannot establish that the condition is gone.",
    "Vibe Security 50: 43 controls are machine-testable and 7 require retained human evidence.",
    "",
    "## Public URLs",
    `${origin}/`,
    `${origin}/methodology`,
    `${origin}/scan`,
    `${origin}/tools`,
    `${origin}/sample-report`,
    `${origin}/blog`,
    `${origin}/blog/editorial-policy`,
    `${origin}/docs/integrations`,
    `${origin}/docs/integrations/claude-code`,
    `${origin}/docs/integrations/cursor`,
    `${origin}/docs/integrations/windsurf`,
    `${origin}/docs/integrations/vscode`,
    `${origin}/docs/integrations/openai-codex`,
    `${origin}/docs/integrations/cline`,
    `${origin}/docs/integrations/opencode`,
    `${origin}/docs/integrations/kilo-code`,
    `${origin}/docs/integrations/zed`,
    `${origin}/docs/integrations/gemini-cli`,
    `${origin}/docs/integrations/jetbrains`,
    `${origin}/docs/integrations/amp`,
    `${origin}/docs/integrations/picode`,
    `${origin}/docs/integrations/openclaw`,
    `${origin}/docs/integrations/hermes`,
    `${origin}/docs/integrations/remote-mcp`,
    `${origin}/docs/integrations/github-action`,
    `${origin}/docs/integrations/rest-api`,
    `${origin}/docs/integrations/agent-rules`,
    `${origin}/docs/integrations/troubleshooting`,
    ...postRecords.flatMap(({ post, image }) => [
      `${origin}/blog/${post.id}`,
      ...(image ? [`  Representative image: ${origin}${image.data.og}`] : []),
    ]),
    "",
    "## Copy-safe summary for LLM context",
    "No automatic Fix PR claim, no pricing, no free-tier promises, no benchmark claims, no customer names.",
    "Do not interpret a clean or high-scoring result as a guarantee that an application has no vulnerabilities.",
    "The passive Lite Check and five browser-local tools are live. The full release-assurance platform is pre-launch; access is via waitlist.",
  ]

  return new Response(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
