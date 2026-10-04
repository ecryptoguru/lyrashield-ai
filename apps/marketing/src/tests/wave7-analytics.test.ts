import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  MARKETING_EVENT_ALLOWLIST,
  sanitizeMarketingProperties,
  type MarketingEventName,
} from "../lib/posthog-privacy"

/**
 * Wave 7 acceptance tests: analytics.
 *
 * Handoff item 7.1 and Spec section 10. The event names ride the existing
 * data-cta-id convention and the privacy-bounded PostHog wrapper. No event may
 * carry a value a visitor typed into the Lite Check field.
 */
const SPEC_EVENTS: MarketingEventName[] = [
  "hero_primary_click",
  "hero_lite_check_click",
  "hero_agent_link_click",
  "nav_menu_open",
  "nav_item_click",
  "different_card_view",
  "journey_chapter_view",
  "surface_tab_click",
  "plan_choose_click",
  "final_cta_click",
  "sticky_bar_click",
  "litecheck_start",
  "litecheck_complete",
  "litecheck_trial_click",
  "template_cta_click",
]

describe("Wave 7 analytics events", () => {
  it("allowlists every event name from Spec section 10", () => {
    for (const event of SPEC_EVENTS) {
      expect(MARKETING_EVENT_ALLOWLIST, `${event} missing from allowlist`).toHaveProperty(event)
    }
  })

  it("never allowlists a URL or target-derived property", () => {
    const banned = new Set(["url", "target", "target_url", "hostname", "referrer", "title", "email"])
    for (const event of SPEC_EVENTS) {
      const props = (MARKETING_EVENT_ALLOWLIST as Record<string, readonly string[]>)[event] ?? []
      for (const prop of props) {
        expect(banned.has(prop), `${event} allowlists ${prop}`).toBe(false)
      }
    }
  })

  it("drops a typed Lite Check value even when it is passed as a property", () => {
    // The typed URL is the single most sensitive value on the marketing site.
    const sanitized = sanitizeMarketingProperties("litecheck_start", {
      product: "lite_check",
      url: "https://customer.example/secret-path",
      target: "customer.example",
      typed_value: "https://customer.example/secret-path",
    })
    expect(sanitized).toEqual({ product: "lite_check" })
  })

  it("emits the named events through the data-analytics-event hook", () => {
    const base = readFileSync(new URL("../layouts/Base.astro", import.meta.url), "utf8")
    expect(base).toContain("data-analytics-event")
    expect(base).toContain("data-analytics-prop")
  })
})
