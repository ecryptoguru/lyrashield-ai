import { describe, expect, it } from "vitest"
import { dashboardExperienceStorageKey, parseDashboardExperience } from "./dashboard-experience"

describe("dashboard experience preference", () => {
  it("accepts only supported modes and defaults safely to guided", () => {
    expect(parseDashboardExperience("pro")).toBe("pro")
    expect(parseDashboardExperience("guided")).toBe("guided")
    expect(parseDashboardExperience("expert")).toBe("guided")
    expect(parseDashboardExperience(null)).toBe("guided")
  })

  it("scopes the preference to the active workspace", () => {
    expect(dashboardExperienceStorageKey("ws-1")).toBe("lyrashield-dashboard-experience:ws-1")
  })
})
