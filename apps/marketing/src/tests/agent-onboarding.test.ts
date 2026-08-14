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
})
