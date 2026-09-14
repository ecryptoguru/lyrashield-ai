import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/**
 * Trial contract drift guard. Canonical terms: 7 days, 60 one-time
 * agent-minutes, up to 3 targets, Safe/Quick/Standard scan modes, no card.
 * Every public surface must agree with the shared catalog — never promise a
 * "full review" (coverage is scope- and depth-dependent) and never restate
 * stale limits (14 days, 100 minutes).
 */
describe("trial contract", () => {
  it("canonical catalog stays 60 one-time minutes, 3 targets, no Deep", () => {
    expect(CLOUD_PLAN_MAP.TRIAL.agentMinutes).toBe(60)
    expect(CLOUD_PLAN_MAP.TRIAL.targetCaps).toBe(3)
    expect(CLOUD_PLAN_MAP.TRIAL.deepAllowed).toBe(false)
    expect(CLOUD_PLAN_MAP.TRIAL.price.usd).toEqual({ monthly: 0, annual: 0 })
  })

  it("public copy never overstates coverage or restates stale limits", () => {
    const surfaces = [
      read("../components/landing/PremiumHero.astro"),
      read("../pages/pricing.astro"),
      read("../pages/terms-of-sale.astro"),
      read("../pages/llms.txt.ts"),
    ]
    for (const surface of surfaces) {
      const lower = surface.toLowerCase()
      expect(surface).not.toMatch(/enough for a full review/i)
      expect(surface).not.toMatch(/14[- ]day/i)
      expect(lower).not.toContain("100 agent-minutes")
      expect(lower).not.toContain("100 agent minutes")
      expect(lower).not.toContain("100 minutes")
      expect(surface).not.toMatch(/unlimited|everything you need/i)
    }
  })

  it("user guide names the included scan modes exactly", () => {
    const guide = read("../../../../docs/user-guide.md")
    const trialLine = guide.split("\n").find((line) => /7-day free trial/i.test(line)) ?? ""
    expect(trialLine).toMatch(/Safe/i)
    expect(trialLine).toMatch(/Quick/i)
    expect(trialLine).toMatch(/Standard/i)
    expect(trialLine).toMatch(/60 agent-minutes/i)
  })
})
