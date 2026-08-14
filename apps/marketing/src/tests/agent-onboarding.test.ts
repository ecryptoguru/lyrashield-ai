import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { agentOnboarding, renderAgentOnboardingMarkdown } from "../lib/agent-onboarding"

describe("agent onboarding contract", () => {
  it("keeps the OAuth-first, approval-gated workflow in one source of truth", () => {
    expect(agentOnboarding.commands).toEqual([
      "npx lyrashield login --oauth",
      "npx lyrashield init",
    ])
    expect(agentOnboarding.safety.join(" ")).toContain("Read-only")
    expect(agentOnboarding.safety.join(" ")).toContain("explicit human approval")
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
