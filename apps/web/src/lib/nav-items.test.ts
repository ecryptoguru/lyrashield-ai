import { describe, it, expect } from "vitest"
import {
  NAV_ITEMS,
  MOBILE_PRIMARY_NAV_ITEMS,
  MORE_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
} from "./nav-items"

/**
 * Regression guard for a shipped defect: the bottom bar rendered
 * PRIMARY_NAV_ITEMS.slice(0, 4) while the More sheet rendered a separate opt-in list,
 * so Approvals, Evidence and Automations appeared in neither and were unreachable on
 * mobile entirely. These assertions make an orphaned destination a build failure.
 */
describe("nav-items mobile coverage", () => {
  it("reaches every destination on mobile — the bottom bar and More sheet are exact complements", () => {
    const reachable = [...MOBILE_PRIMARY_NAV_ITEMS, ...MORE_NAV_ITEMS]
      .map((item) => item.href)
      .sort()
    expect(reachable).toEqual(NAV_ITEMS.map((item) => item.href).sort())
  })

  it("counts every nav item exactly once across the two mobile surfaces", () => {
    expect(MOBILE_PRIMARY_NAV_ITEMS.length + MORE_NAV_ITEMS.length).toBe(NAV_ITEMS.length)
  })

  it("never lists the same destination in both mobile surfaces", () => {
    const more = new Set(MORE_NAV_ITEMS.map((item) => item.href))
    for (const item of MOBILE_PRIMARY_NAV_ITEMS) {
      expect(more.has(item.href)).toBe(false)
    }
  })

  it("fills exactly the four fixed bottom-bar slots (the fifth is the More trigger)", () => {
    expect(MOBILE_PRIMARY_NAV_ITEMS).toHaveLength(4)
  })

  it("keeps desktop groups complementary too", () => {
    expect(PRIMARY_NAV_ITEMS.length + SECONDARY_NAV_ITEMS.length).toBe(NAV_ITEMS.length)
  })

  it("has no duplicate hrefs", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("gives every item a non-empty label, short label and icon", () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.shortLabel.length).toBeGreaterThan(0)
      expect(item.icon).toBeTruthy()
    }
  })
})
