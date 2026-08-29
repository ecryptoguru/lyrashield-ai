import type { APIRoute } from "astro"
import { getCollection, getEntry } from "astro:content"
import { tools } from "../lib/tools"
// Relative filesystem import on purpose, not "@lyrashield/security" — see the
// identical note in vibe-security-50.astro. The package index re-exports the
// SSRF/fetch helpers, which pull in undici and break the Cloudflare Worker
// bundle; a pnpm "workspace:*" dependency here also broke the production
// marketing deploy previously, because wrangler-action's own npm install step
// runs inside apps/marketing with plain npm, which does not understand the
// "workspace:" protocol. A relative import reads the file directly and needs
// no package.json entry.
import { VIBE_SECURITY_CONTROLS } from "../../../../packages/security/src/vibe-security-controls"

export const prerender = false

// Same registry vibe-security-50.astro builds its own counts from — hardcoding
// "43"/"7" here as separate prose would let this file silently disagree with
// the page it's meant to summarize the moment the control list changes.
const reviewControlCount = VIBE_SECURITY_CONTROLS.filter(
  (control) => control.strategy !== "evidence"
).length
const evidenceControlCount = VIBE_SECURITY_CONTROLS.filter(
  (control) => control.strategy === "evidence"
).length

// Bump this by hand only when a section's CONTENT changes, not on every
// deploy. `new Date()` here would print "today" on every build regardless of
// whether anything moved, which trains an LLM fetching this file on a
// schedule to either believe the site changes constantly or to stop trusting
// the field. See astro.config.mjs's sitemap lastmod comment for the same
// principle applied to the sitemap.
const LLMS_TXT_CONTENT_DATE = "2026-08-29"

const docsLinks = [
  { label: "REST API reference", path: "/docs/api" },
  { label: "Remote action approvals", path: "/docs/approvals" },
  { label: "Coding-agent integrations", path: "/docs/integrations" },
  { label: "Agent Plugin installation", path: "/docs/integrations/agent-plugins" },
  { label: "Agent rule installation", path: "/docs/integrations/agent-rules" },
  { label: "Aider integration", path: "/docs/integrations/aider" },
  { label: "Amp integration", path: "/docs/integrations/amp" },
  { label: "Antigravity integration", path: "/docs/integrations/antigravity" },
  { label: "Claude Code integration", path: "/docs/integrations/claude-code" },
  { label: "Cline integration", path: "/docs/integrations/cline" },
  { label: "Codebuff integration", path: "/docs/integrations/codebuff" },
  { label: "GitHub Copilot CLI integration", path: "/docs/integrations/copilot-cli" },
  { label: "Cursor integration", path: "/docs/integrations/cursor" },
  { label: "Devin CLI integration", path: "/docs/integrations/devin-cli" },
  { label: "Gemini CLI integration", path: "/docs/integrations/gemini-cli" },
  { label: "GitHub Action integration", path: "/docs/integrations/github-action" },
  { label: "GitHub Copilot integration", path: "/docs/integrations/github-copilot" },
  { label: "Goose integration", path: "/docs/integrations/goose" },
  { label: "Hermes integration", path: "/docs/integrations/hermes" },
  { label: "JetBrains integration", path: "/docs/integrations/jetbrains" },
  { label: "Kilo Code integration", path: "/docs/integrations/kilo-code" },
  { label: "Kiro integration", path: "/docs/integrations/kiro" },
  { label: "MiMo Code integration", path: "/docs/integrations/mimo-code" },
  { label: "Oh My Pi integration", path: "/docs/integrations/oh-my-pi" },
  { label: "OpenAI Codex integration", path: "/docs/integrations/openai-codex" },
  { label: "OpenClaw integration", path: "/docs/integrations/openclaw" },
  { label: "OpenCode integration", path: "/docs/integrations/opencode" },
  { label: "Pi coding agent integration", path: "/docs/integrations/picode" },
  { label: "Remote MCP setup", path: "/docs/integrations/remote-mcp" },
  { label: "REST API integration", path: "/docs/integrations/rest-api" },
  { label: "Roo Code integration", path: "/docs/integrations/roo-code" },
  { label: "Integration troubleshooting", path: "/docs/integrations/troubleshooting" },
  { label: "Visual Studio Code integration", path: "/docs/integrations/vscode" },
  { label: "Devin integration", path: "/docs/integrations/devin" },
  { label: "Zed integration", path: "/docs/integrations/zed" },
]

// Paths that are always noindex or scanner-gated and should not be cited.
const excludedPathnames = new Set(["/terms", "/scan", "/404"])
const markdownLink = (label: string, url: string) => `[${label}](${url})`

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

  const publicLinks = [
    { label: "LyraShield AI", url: `${origin}/` },
    { label: "Coding-agent security", url: `${origin}/agents` },
    { label: "Machine-readable agent setup", url: `${origin}/agents.md` },
    { label: "About LyraShield AI", url: `${origin}/about` },
    { label: "Evidence methodology", url: `${origin}/methodology` },
    { label: "Security research", url: `${origin}/research` },
    { label: "Security-tool comparisons", url: `${origin}/compare` },
    { label: "LyraShield AI and Snyk", url: `${origin}/compare/snyk` },
    {
      label: "LyraShield AI and GitHub Advanced Security",
      url: `${origin}/compare/github-advanced-security`,
    },
    { label: "LyraShield AI and SonarQube", url: `${origin}/compare/sonarqube` },
    { label: "LyraShield AI and Semgrep", url: `${origin}/compare/semgrep` },
    { label: "Free browser-local security tools", url: `${origin}/tools` },
    ...tools.map((tool) => ({
      label: tool.title,
      url: `${origin}/tools/${tool.slug}`,
    })),
    { label: "Vibe Security 50 controls", url: `${origin}/vibe-security-50` },
    { label: "Operational Evidence Vault", url: `${origin}/evidence-vault` },
    { label: "AI safety claims and limits", url: `${origin}/ai-safety` },
    { label: "LyraShield AI support", url: `${origin}/support` },
    { label: "Security vulnerability reporting", url: `${origin}/security-reporting` },
    { label: "Privacy policy", url: `${origin}/privacy` },
    { label: "Security and launch-readiness guides", url: `${origin}/blog` },
    { label: "Editorial policy", url: `${origin}/blog/editorial-policy` },
    ...docsLinks
      .map(({ label, path }) => ({ label, url: `${origin}${path}` }))
      .filter(({ url }) => !excludedPathnames.has(new URL(url).pathname)),
    ...postRecords.flatMap(({ post, image }) => [
      { label: post.data.title, url: `${origin}/blog/${post.id}` },
      ...(image
        ? [{ label: `${post.data.title} representative image`, url: `${origin}${image.data.og}` }]
        : []),
    ]),
  ]

  const toolList = tools.map((tool) => tool.title).join(", ")

  const sections = [
    "# LyraShield AI — llms.txt",
    "",
    `Last updated: ${LLMS_TXT_CONTENT_DATE}`,
    "",
    "LyraShield AI is a SaaS release-assurance platform for AI-built apps. The same review-and-evidence engine also ships as a published CLI, a GitHub Action, and an MCP server inside coding agents — it is one product across four surfaces, not four separate tools. It is in open beta with open registration; there is no waitlist.",
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
    `Release assurance: a reviewable record combining scope, coverage, findings and their evidence states, fix proposals, and retest outcomes that supports a release decision — it is not a certification or a guarantee that an application has no vulnerabilities.`,
    `Vibe Security 50: ${reviewControlCount} controls are routed to code or URL review where applicable and ${evidenceControlCount} require operational or human evidence outside the scan.`,
    "Operational Evidence Vault: a private, workspace-scoped, encrypted, and versioned place to submit, review, and accept evidence for the 7 evidence-required Vibe Security 50 controls. Accepted evidence is frozen into private assurance reports; public/shared reports do not expose AI-assurance data or raw storage URIs.",
    "",
    "WebMCP Assurance: a browser-local, read-only model-context policy checker for pages that expose WebMCP tools. It analyzes selected source files or pasted code for 10 controls, prepares a bounded rewrite diff, and exports JSON, Markdown, or SARIF. Nothing is uploaded.",
    "WebMCP public pages: /webmcp (explanatory guide), /tools/webmcp-security-checker (interactive checker), and /webmcp-controls.json (public control registry).",
    "WebMCP tools: analyze_webmcp_source, prepare_webmcp_rewrite, and the page-scoped read-only explain_webmcp_assurance on /webmcp.",
    "WebMCP limitations: WebMCP is experimental and not universally supported. A clean result does not prove an application is secure, and the checker does not write to your repository or create a workspace authorization channel.",
    "",
    "## Public URLs",
    ...publicLinks.map(({ label, url }) => markdownLink(label, url)),
    "",
    "## Agent-native setup",
    "Start with `npx lyrashield login --oauth`, then `npx lyrashield init` to install the Agent Plugin for your coding agent. Read-only tools are available after workspace authentication; mutating tools require write scope and explicit human approval outside the agent.",
    `Human-facing setup: ${markdownLink("Coding-agent security", `${origin}/agents`)}. Machine-readable setup contract: ${markdownLink("agents.md", `${origin}/agents.md`)}. Full guide: ${markdownLink("Agent Plugin installation", `${origin}/docs/integrations/agent-plugins`)}.`,
    "",
    "## Copy-safe summary for LLM context",
    "No automatic Fix PR claim, no benchmark claims, no customer names. Pricing and plan limits are not yet announced.",
    "Joining the open beta and using the full platform today costs nothing: registration is free with no card required. LyraShield has not announced what paid plans or limits will look like once the beta matures.",
    "Do not interpret a clean or high-scoring result as a guarantee that an application has no vulnerabilities.",
    "LyraShield does not claim 'SOC 2 compliant,' 'certified,' 'guarantees security,' 'AI safety tested' (without a named framework), or 'adversarial robustness proven.' Each requires external attestation, a reproducible evaluation corpus, a defined threat model, or a formal certificate LyraShield has not yet obtained.",
    "Fix proposals are approval-gated: they require explicit human review on the controlling terminal and fail closed when no terminal is present. Nothing auto-merges.",
    `The passive Lite Check and these ${tools.length} free browser-local tools need no account and run entirely client-side: ${toolList}.`,
    `The full release-assurance platform is in open beta with open registration: ${markdownLink("Create a free LyraShield AI account", "https://app.lyrashieldai.com/sign-up")}. Access is not gated behind a waitlist; the email form on the site is an optional product-updates subscription.`,
    "LyraShield also runs as an MCP server inside coding agents. Setup is `npx lyrashield init`; the CLI is published on npm.",
    `LyraShield AI's ${markdownLink("LyraShield AI source code on GitHub", "https://github.com/ecryptoguru/lyrashield-ai")} is under the MIT License; the LyraShield AI name and logos are not included in that license. This covers the published source, not separately hosted backend services.`,
  ]

  return new Response(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
