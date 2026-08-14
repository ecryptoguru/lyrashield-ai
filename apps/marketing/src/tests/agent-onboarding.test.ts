import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { agentOnboarding, renderAgentOnboardingMarkdown } from "../lib/agent-onboarding"

describe("agent onboarding contract", () => {
  it("keeps the OAuth-first, approval-gated workflow in one source of truth", () => {
    expect(agentOnboarding.commands).toEqual(["npx lyrashield login --oauth", "npx lyrashield init"])
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
})
