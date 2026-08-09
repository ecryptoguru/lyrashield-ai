import type { APIRoute } from "astro"
import { getCollection, getEntry } from "astro:content"
import { tools } from "../lib/tools"

export const prerender = false

const docsPaths = [
  "/docs/api",
  "/docs/approvals",
  "/docs/integrations",
  "/docs/integrations/agent-rules",
  "/docs/integrations/aider",
  "/docs/integrations/amp",
  "/docs/integrations/antigravity",
  "/docs/integrations/claude-code",
  "/docs/integrations/cline",
  "/docs/integrations/codebuff",
  "/docs/integrations/copilot-cli",
  "/docs/integrations/cursor",
  "/docs/integrations/devin-cli",
  "/docs/integrations/gemini-cli",
  "/docs/integrations/github-action",
  "/docs/integrations/github-copilot",
  "/docs/integrations/goose",
  "/docs/integrations/hermes",
  "/docs/integrations/jetbrains",
  "/docs/integrations/kilo-code",
  "/docs/integrations/kiro",
  "/docs/integrations/mimo-code",
  "/docs/integrations/oh-my-pi",
  "/docs/integrations/openai-codex",
  "/docs/integrations/openclaw",
  "/docs/integrations/opencode",
  "/docs/integrations/picode",
  "/docs/integrations/remote-mcp",
  "/docs/integrations/rest-api",
  "/docs/integrations/roo-code",
  "/docs/integrations/troubleshooting",
  "/docs/integrations/vscode",
  "/docs/integrations/windsurf",
  "/docs/integrations/zed",
]

// Paths that are always noindex or scanner-gated and should not be cited.
const excludedPathnames = new Set(["/terms", "/scan", "/404"])

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

  const toolSlugs = tools.map((tool) => `${origin}/tools/${tool.slug}`)

  const publicPaths = [
    `${origin}/`,
    `${origin}/about`,
    `${origin}/methodology`,
    `${origin}/research`,
    `${origin}/compare`,
    `${origin}/compare/snyk`,
    `${origin}/compare/github-advanced-security`,
    `${origin}/compare/sonarqube`,
    `${origin}/compare/semgrep`,
    `${origin}/tools`,
    ...toolSlugs,
    `${origin}/vibe-security-50`,
    `${origin}/sample-report`,
    `${origin}/blog`,
    `${origin}/blog/editorial-policy`,
    ...docsPaths
      .map((path) => `${origin}${path}`)
      .filter((url) => !excludedPathnames.has(new URL(url).pathname)),
    ...postRecords.flatMap(({ post, image }) => [
      `${origin}/blog/${post.id}`,
      ...(image ? [`  Representative image: ${origin}${image.data.og}`] : []),
    ]),
  ]

  const sections = [
    "# LyraShield AI — llms.txt",
    "",
    `Last updated: ${new Date().toISOString().split("T")[0]}`,
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
    ...publicPaths,
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
