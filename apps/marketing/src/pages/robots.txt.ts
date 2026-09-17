import type { APIRoute } from "astro"

/**
 * Retrieval and search agents that must be named explicitly.
 *
 * Relying on the permissive wildcard means a future tightening of `*` would
 * silently revoke access for the crawlers this product most wants to be cited
 * by, so each one gets its own group. `scripts/crawl-built-site.mjs` asserts
 * every name here is present in the built file.
 */
const RETRIEVAL_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "GoogleOther",
  "Applebot",
  "Applebot-Extended",
  "DuckAssistBot",
  "meta-externalagent",
  "Amazonbot",
  "YouBot",
  "cohere-ai",
  "MistralAI-User",
  "AI2Bot",
  "Diffbot",
  "Timpibot",
  "Bytespider",
]

/**
 * Training-capable crawlers. They stay allowed: the published posture is that
 * public marketing content is crawlable, and naming them here keeps that a
 * recorded decision rather than an accident of the wildcard.
 */
const TRAINING_AGENTS = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"]

function group(agents: string[]): string {
  return `${agents.map((agent) => `User-agent: ${agent}`).join("\n")}\nDisallow:\n`
}

export const GET: APIRoute = async (context) => {
  const indexable = __MARKETING_INDEXABLE__

  if (!indexable) {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  const siteUrl = context.site?.toString() || "http://localhost:4321"
  const siteOrigin = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl

  return new Response(
    [
      "# LyraShield AI — https://lyrashieldai.com/robots.txt",
      "#",
      "# Policy: everything public is crawlable by search and answer engines.",
      "# Retrieval agents are named explicitly so a future tightening of `*`",
      "# cannot silently revoke citation access.",
      "",
      "User-agent: *",
      "Disallow:",
      "",
      "# Answer-engine retrieval and search agents.",
      group(RETRIEVAL_AGENTS),
      "# Training-capable crawlers — allowed by the same policy.",
      group(TRAINING_AGENTS),
      `Sitemap: ${siteOrigin}/sitemap-index.xml`,
      "",
    ].join("\n"),
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }
  )
}
