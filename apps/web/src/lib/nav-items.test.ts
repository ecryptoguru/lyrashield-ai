import { describe, it, expect } from "vitest"
import {
  NAV_ITEMS,
  NAV_TITLE_ITEMS,
  MOBILE_PRIMARY_NAV_ITEMS,
  MORE_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
  resolveNav,
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

describe("nav-items lifecycle primary destinations", () => {
  it("exposes exactly the four lifecycle destinations as primary", () => {
    const hrefs = PRIMARY_NAV_ITEMS.map((i) => i.href)
    expect(hrefs).toEqual([
      "/dashboard",
      "/dashboard/targets",
      "/dashboard/scans",
      "/dashboard/findings",
    ])
  })

  it("exposes exactly the four lifecycle destinations as mobile primary", () => {
    const hrefs = MOBILE_PRIMARY_NAV_ITEMS.map((i) => i.href)
    expect(hrefs).toEqual([
      "/dashboard",
      "/dashboard/targets",
      "/dashboard/scans",
      "/dashboard/findings",
    ])
  })
})

describe("nav-items workspace destinations", () => {
  it("keeps coding agents before direct service integrations", () => {
    expect(SECONDARY_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard/notifications",
      "/dashboard/agents",
      "/dashboard/integrations",
      "/dashboard/ai-assurance",
      "/dashboard/team",
      "/dashboard/settings",
    ])
  })
})

describe("nav-items conditional Review Queue", () => {
  it("hides Review Queue when there are no pending approvals", () => {
    const nav = resolveNav({ pendingApprovals: 0 })
    expect(nav.reviewQueue).toBeNull()
    expect(nav.secondary.map((i) => i.href)).not.toContain("/dashboard/approvals")
    expect(nav.more.map((i) => i.href)).not.toContain("/dashboard/approvals")
  })

  it("shows Review Queue with a badge when pending approvals exist", () => {
    const nav = resolveNav({ pendingApprovals: 3 })
    expect(nav.reviewQueue).not.toBeNull()
    expect(nav.reviewQueue?.href).toBe("/dashboard/approvals")
    expect(nav.reviewQueue?.badgeCount).toBe(3)
    expect(nav.secondary.map((i) => i.href)).toContain("/dashboard/approvals")
    expect(nav.more.map((i) => i.href)).toContain("/dashboard/approvals")
  })

  it("keeps the four lifecycle destinations stable regardless of pending approvals", () => {
    const empty = resolveNav({ pendingApprovals: 0 })
    const withPending = resolveNav({ pendingApprovals: 5 })
    expect(empty.mobilePrimary).toEqual(withPending.mobilePrimary)
    expect(empty.primary).toEqual(withPending.primary)
    expect(empty.mobilePrimary).toHaveLength(4)
  })

  it("does not duplicate any destination when Review Queue is visible", () => {
    const nav = resolveNav({ pendingApprovals: 1 })
    const hrefs = nav.items.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("defaults to zero pending approvals when state is omitted", () => {
    const nav = resolveNav()
    expect(nav.reviewQueue).toBeNull()
  })
})

describe("nav-items title lookup", () => {
  it("includes the Review Queue route for page-title resolution", () => {
    const hrefs = NAV_TITLE_ITEMS.map((i) => i.href)
    expect(hrefs).toContain("/dashboard/approvals")
  })

  it("has no duplicate hrefs in the title lookup list", () => {
    const hrefs = NAV_TITLE_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})
