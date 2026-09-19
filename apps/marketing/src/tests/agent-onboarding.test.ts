import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { agentOnboarding, renderAgentOnboardingMarkdown } from "../lib/agent-onboarding"

describe("agent onboarding contract", () => {
  it("labels supported workflows and delegated authorization accurately", () => {
    expect(agentOnboarding.commands).toEqual([
      "npx lyrashield login --oauth",
      "npx lyrashield init",
    ])
    expect(agentOnboarding.safety.join(" ")).toContain("Read-only")
    expect(agentOnboarding.safety.join(" ")).toContain("browser-confirmed connection grant")
    expect(agentOnboarding.clients).toHaveLength(26)
    expect(agentOnboarding.clients.filter((client) => client.integrationKind === "standalone-cli")).toHaveLength(2)
    expect(agentOnboarding.clients.every((client) => client.supportTier !== "VERIFIED" || client.clientVersion && client.platforms.length > 0)).toBe(true)
    expect(renderAgentOnboardingMarkdown("https://lyrashieldai.com")).toContain(
      "https://lyrashieldai.com/docs/integrations/agent-plugins"
    )
  })

  it("publishes matching visual and Markdown onboarding surfaces", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const agentPage = readFileSync(new URL("../pages/agents.astro", import.meta.url), "utf8")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const markdownRoute = readFileSync(new URL("../pages/agents.md.ts", import.meta.url), "utf8")

    expect(agentPage).toContain("agentOnboarding")
    expect(agentPage).toContain('data-cta-id="agents-start-setup"')
    expect(markdownRoute).toContain('"Content-Type": "text/markdown; charset=utf-8"')
    expect(markdownRoute).toContain("renderAgentOnboardingMarkdown(origin)")
  })

  it("serves the Markdown onboarding contract from the agents.md endpoint", async () => {
    // Direct handler invocation — the browser suite cannot cover this route
    // because extensioned SSR paths self-redirect under `wrangler dev --local`
    // (asset-layer slash normalization vs Astro trailingSlash:"never").
    const { GET } = await import("../pages/agents.md")
    const context = {
      site: new URL("https://lyrashieldai.com"),
    } as unknown as Parameters<typeof GET>[0]
    const response = await GET(context)

    expect(response.headers.get("Content-Type")).toContain("text/markdown")
    const body = await response.text()
    expect(body).toContain("# Release assurance for coding agents")
    expect(body).toContain("https://lyrashieldai.com/docs/integrations/agent-plugins")
    expect(body).not.toContain("${origin}")
  })

  it("serves concrete agent setup URLs from the llms.txt endpoint", async () => {
    // Direct handler invocation preserves runtime response coverage without
    // Wrangler's extension-path redirect behavior.
    const { GET } = await import("../pages/llms.txt")
    const context = {
      site: new URL("https://lyrashieldai.com"),
    } as unknown as Parameters<typeof GET>[0]
    const response = await GET(context)

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/plain")
    const body = await response.text()
    expect(body).toContain("https://lyrashieldai.com/agents")
    expect(body).toContain("https://lyrashieldai.com/agents.md")
    expect(body).not.toContain("${origin}")
  })

  it("keeps a human-first funnel while exposing agent setup", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const header = readFileSync(new URL("../components/Header.astro", import.meta.url), "utf8")
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const hero = readFileSync(
      new URL("../components/landing/PremiumHero.astro", import.meta.url),
      "utf8"
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const finalCta = readFileSync(
      new URL("../components/landing/FinalCta.astro", import.meta.url),
      "utf8"
    )

    expect(header.match(/href="\/agents"/g)).toHaveLength(2)
    expect(header).toContain('data-cta-id="header-for-agents"')
    expect(header).toContain('data-cta-id="header-for-agents-mobile"')
    expect(hero).toContain('data-cta-id="premium-hero-agent-setup"')
    expect(finalCta).toContain('data-cta-id="final-cta-agent-setup"')
    expect(hero).not.toContain("data-switch-mode")
  })
})
