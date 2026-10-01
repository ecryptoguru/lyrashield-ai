import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { listPreferredAgents } from "@lyrashield/agent-registry"
import { agentOnboarding, renderAgentOnboardingMarkdown } from "../lib/agent-onboarding"

describe("agent onboarding contract", () => {
  it("labels supported workflows and delegated authorization accurately", () => {
    expect(agentOnboarding.commands).toEqual([
      "npx --yes lyrashield@0.2.13 login --oauth",
      "npx --yes lyrashield@0.2.13 init --dry-run",
    ])
    expect(agentOnboarding.setupHeading).toBe("Preview local stdio setup")
    expect(agentOnboarding.setupDescription).toContain(
      "The second previews setup paths only; it does not write client configuration."
    )
    expect(agentOnboarding.safety.join(" ")).toContain("Read-only")
    expect(agentOnboarding.safety.join(" ")).toContain("browser-confirmed connection grant")
    expect(agentOnboarding.safety.join(" ")).toContain(
      "config-file clients while the safe-writer fix is pending"
    )
    expect(
      agentOnboarding.clients.find((client) => client.strategy === "config-file")?.strategyLabel
    ).toBe("Manual config merge")
    expect(agentOnboarding.clients).toHaveLength(listPreferredAgents().length)
    expect(agentOnboarding.clients.map((client) => client.href)).toContain(
      "/docs/integrations/claude-web"
    )
    expect(agentOnboarding.clients.map((client) => client.href)).toContain(
      "/docs/integrations/replit-agent"
    )
    expect(agentOnboarding.clientGroups.map((group) => group.strategy)).toEqual(
      expect.arrayContaining(["agent-plugin", "config-file", "guided-manual", "vendor-cli"])
    )
    expect(
      agentOnboarding.clients.filter((client) => client.integrationKind === "standalone-cli")
    ).toHaveLength(1)
    expect(
      agentOnboarding.clients.every(
        (client) =>
          client.supportTier !== "VERIFIED" || (client.clientVersion && client.platforms.length > 0)
      )
    ).toBe(true)
    expect(renderAgentOnboardingMarkdown("https://lyrashieldai.com")).toContain(
      "https://lyrashieldai.com/docs/integrations/agent-plugins"
    )
  })

  it("publishes manual VS Code plugin setup and flags the stale published Pi preview", () => {
    const client = agentOnboarding.clients.find(
      (entry) => entry.href === "/docs/integrations/vscode-agent-plugin"
    )
    expect(client?.strategyLabel).toBe("Manual Agent Plugin setup")
    const body = renderAgentOnboardingMarkdown("https://lyrashieldai.com")
    expect(body).toContain("Manual Agent Plugin setup")
    expect(body).toContain("published CLI 0.2.13 preview predates Pi's native MCP")
    expect(body).toContain("/docs/integrations/pi")
  })

  it("publishes matching visual and Markdown onboarding surfaces", () => {
    const agentPage = readFileSync(new URL("../pages/agents.astro", import.meta.url), "utf8")
    const markdownRoute = readFileSync(new URL("../pages/agents.md.ts", import.meta.url), "utf8")

    expect(agentPage).toContain("agentOnboarding")
    expect(agentPage).toContain('data-cta-id="agents-start-setup"')
    expect(agentPage).toContain("pending the safe-writer fix")
    expect(agentPage).toContain("npx --yes lyrashield@0.2.13 init --dry-run")
    expect(agentPage).not.toContain("npx lyrashield init")
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
    expect(body).toContain("npx --yes lyrashield@0.2.13 init --dry-run")
    expect(body).toContain("## Preview local stdio setup")
    expect(body).toContain(
      "The second previews setup paths only; it does not write client configuration."
    )
    expect(body).toContain("config-file clients while the safe-writer fix is pending")
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
    for (const slug of new Set(listPreferredAgents().map((agent) => agent.docsSlug))) {
      expect(body, `llms.txt must include the ${slug} integration guide`).toContain(
        `https://lyrashieldai.com/docs/integrations/${slug}`
      )
    }
    expect(body).not.toContain("${origin}")
  })

  it("keeps a human-first funnel while exposing agent setup", () => {
    const header = readFileSync(new URL("../components/Header.astro", import.meta.url), "utf8")
    const hero = readFileSync(
      new URL("../components/landing/PremiumHero.astro", import.meta.url),
      "utf8"
    )
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
