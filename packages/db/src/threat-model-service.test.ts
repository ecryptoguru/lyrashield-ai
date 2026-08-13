import { describe, expect, it } from "vitest"
import {
  threatModelMarkdown,
  validateThreatModel,
  type ThreatModelInput,
} from "./threat-model-service"

const input: ThreatModelInput = {
  scope: "Customer support assistant",
  assets: ["Conversation data"],
  trustBoundaries: ["Public browser to API"],
  threats: [
    {
      title: "Prompt injection",
      severity: "HIGH",
      description: "Untrusted content influences model instructions.",
      mitigation: "Separate trusted instructions from retrieved content.",
      testPlan: "Run approved injection fixtures.",
      owner: "Application security",
      reviewDate: "2026-09-01",
    },
  ],
}

describe("threat model service", () => {
  it("requires an owner, mitigation, and test plan for high-impact threats", () => {
    expect(() =>
      validateThreatModel({ ...input, threats: [{ ...input.threats[0], owner: null }] })
    ).toThrow("THREAT_MODEL_OWNER_INVALID")
  })

  it("exports customer-declared Markdown without verification claims", () => {
    const markdown = threatModelMarkdown(input)
    expect(markdown).toContain("# Customer-declared threat model")
    expect(markdown).toContain("Prompt injection (HIGH)")
    expect(markdown).toContain("not independently verified")
  })
})
