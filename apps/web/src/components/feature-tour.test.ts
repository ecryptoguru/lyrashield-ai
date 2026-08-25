import { describe, expect, it } from "vitest"
import { FEATURE_TOUR_STEPS, featureTourStorageKey } from "./feature-tour"

describe("feature tour", () => {
  it("has exactly five steps, each explaining a real feature surface", () => {
    expect(FEATURE_TOUR_STEPS).toHaveLength(5)
    for (const step of FEATURE_TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.description.length).toBeGreaterThan(0)
      expect(step.cta.length).toBeGreaterThan(0)
      expect(step.href.startsWith("/dashboard")).toBe(true)
    }
  })

  it("covers the core loop in order: target, run, issues, review queue, agents", () => {
    expect(FEATURE_TOUR_STEPS.map((step) => step.href)).toEqual([
      "/dashboard/targets",
      "/dashboard/scans",
      "/dashboard/findings",
      "/dashboard/approvals",
      "/dashboard/agents",
    ])
  })

  it("scopes dismissal to the active workspace", () => {
    expect(featureTourStorageKey("ws-1")).toBe("lyrashield-feature-tour-dismissed:ws-1")
  })
})
