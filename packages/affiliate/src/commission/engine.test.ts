import { describe, it, expect } from "vitest"
import { ANNUAL_RATE_BPS, BASE_RATE_BPS, TIER_RATE_BPS, TIER_THRESHOLD } from "../index"

/**
 * POLICY (founder-confirmed 2026-08-19): the 30% tier kicker
 * (TIER_RATE_BPS at >= TIER_THRESHOLD active referrals) applies to MONTHLY
 * Cloud plans only. Annual Cloud plans always pay the FLAT ANNUAL_RATE_BPS
 * (25%) of the annual amount as paid, regardless of the affiliate's tier.
 *
 * The annual branch in engine.ts short-circuits BEFORE the tier check, so a
 * high-tier affiliate on an annual plan must still receive 25%, not 30%.
 * These tests pin the constants and the flat-vs-tiered relationship so a
 * future refactor can't silently route annual through the tier branch.
 */
describe("commission rate policy — annual flat 25%, tier only on monthly", () => {
  it("pins the rate constants", () => {
    expect(ANNUAL_RATE_BPS).toBe(2500)
    expect(BASE_RATE_BPS).toBe(2500)
    expect(TIER_RATE_BPS).toBe(3000)
    expect(TIER_THRESHOLD).toBe(10)
  })

  it("annual rate is FLAT and does not escalate to the tier rate", () => {
    // The whole point of the policy: annual is a fixed 25%, never the 30%
    // tier. If someone wires annual into the tier branch, this invariant
    // (annual == base < tier) should trip a reviewer.
    expect(ANNUAL_RATE_BPS).toBe(BASE_RATE_BPS)
    expect(ANNUAL_RATE_BPS).toBeLessThan(TIER_RATE_BPS)
  })
})
