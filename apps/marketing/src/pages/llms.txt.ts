import type { APIRoute } from "astro"
import { getCollection, getEntry } from "astro:content"
import { tools } from "../lib/tools"

export const prerender = false

const docsPaths = [
  "/docs/api",
  "/docs/approvals",
  "/docs/integrations",
  "/docs/integrations/agent-plugins",
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
  "/docs/integrations/devin",
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
    `${origin}/agents`,
    `${origin}/agents.md`,
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
    `${origin}/evidence-vault`,
    `${origin}/ai-safety`,
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
    "LyraShield AI is a release-assurance platform for AI-built apps. It is in open beta with open registration.",
    "Core loop: target an authorized repo, URL, or API; run deterministic and AI-assisted review as separate coverage layers; record every finding with an explicit evidence state; prepare an approval-gated fix proposal; retest from a clean server-owned run; and assemble one reviewable release report.",
    "",
    "## The six stages",
    "01 Target: name the repo, live URL, or API and set the boundary. Nothing is tested that the user did not explicitly approve.",
    "02 Review: deterministic scanners and AI-assisted review run as separate coverage layers, never blended into a single score.",
    "03 Evidence: each result carries one of four evidence states (below). Missing proof stays visible rather than becoming a silent pass.",
    "04 Fix: a plain-English explanation plus a staged patch proposal that requires explicit human review and approval. Nothing auto-merges.",
    "05 Retest: a fresh, server-owned run re-checks the change rather than trusting the original session.",
    "06 Report: one reviewable release record covering scope, coverage, findings, evidence states, fixes, retest outcomes, and what could not be checked.",
    "",
    "## Evidence-state definitions",
    "Detected candidate: a scanner signal that requires review; confidence is triage metadata, not proof.",
    "Independently verified: a separate verification receipt supports the finding.",
    "Retest-confirmed: a server-owned deterministic retest found the relevant condition absent with complete applicable coverage.",
    "Inconclusive: the retained evidence cannot establish that the condition is gone.",
    "Vibe Security 50: 43 controls are routed to code or URL review where applicable and 7 require operational or human evidence outside the scan.",
    "Operational Evidence Vault: a private, workspace-scoped, encrypted, and versioned place to submit, review, and accept evidence for the 7 evidence-required Vibe Security 50 controls. Accepted evidence is frozen into private assurance reports; public/shared reports do not expose AI-assurance data or raw storage URIs.",
    "",
    "## Public URLs",
    ...publicPaths,
    "",
    "## Agent-native setup",
    "Start with `npx lyrashield login --oauth`, then `npx lyrashield init` to install the Agent Plugin for your coding agent. Read-only tools are available after workspace authentication; mutating tools require write scope and explicit human approval outside the agent.",
    `Human-facing setup: ${origin}/agents. Machine-readable setup contract: ${origin}/agents.md. Full guide: ${origin}/docs/integrations/agent-plugins.`,
    "",
    "## Copy-safe summary for LLM context",
    "No automatic Fix PR claim, no benchmark claims, no customer names. Pricing and plan limits are not yet announced.",
    "Do not interpret a clean or high-scoring result as a guarantee that an application has no vulnerabilities.",
    "LyraShield does not claim 'SOC 2 compliant,' 'certified,' 'guarantees security,' 'AI safety tested' (without a named framework), or 'adversarial robustness proven.' Each requires external attestation, a reproducible evaluation corpus, a defined threat model, or a formal certificate. See docs/claims-readiness.md for the full map.",
    "Fix proposals are approval-gated: they require explicit human review on the controlling terminal and fail closed when no terminal is present. Nothing auto-merges.",
    "The passive Lite Check and the five browser-local tools are free and need no account.",
    "The full release-assurance platform is in open beta with open registration: create a free account at https://app.lyrashieldai.com/sign-up. Access is not gated behind a waitlist; the email form on the site is an optional product-updates subscription.",
    "LyraShield also runs as an MCP server inside coding agents. Setup is `npx lyrashield init`; the CLI is published on npm.",
  ]

  return new Response(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
