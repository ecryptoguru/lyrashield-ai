import { describe, it, expect } from "vitest"
import {
  LOCAL_SKU_MAP,
  TEAM_VOLUME_THRESHOLD,
  TEAM_VOLUME_DISCOUNT_PCT,
  qualifiesForTeamVolumeDiscount,
  teamSeatPrice,
  teamOrderTotal,
  teamVolumeDiscountPct,
} from "./local"

describe("local pricing — team 10% volume discount at 10+ seats (FAIL-B1)", () => {
  it("team_perpetual qualifies for the volume discount", () => {
    expect(qualifiesForTeamVolumeDiscount("team_perpetual")).toBe(true)
  })

  it("team_subscription qualifies for the volume discount", () => {
    expect(qualifiesForTeamVolumeDiscount("team_subscription")).toBe(true)
  })

  it("individual SKUs do NOT qualify for the volume discount", () => {
    expect(qualifiesForTeamVolumeDiscount("individual_launch")).toBe(false)
    expect(qualifiesForTeamVolumeDiscount("individual_regular")).toBe(false)
  })

  it("renewal / sync_addon do NOT qualify for the volume discount", () => {
    expect(qualifiesForTeamVolumeDiscount("renewal")).toBe(false)
    expect(qualifiesForTeamVolumeDiscount("sync_addon")).toBe(false)
  })

  it("team_perpetual: list price below threshold, 10% off at/above threshold", () => {
    const listPrice = LOCAL_SKU_MAP["team_perpetual"]!.priceUsd
    expect(teamSeatPrice("team_perpetual", 3)).toBe(listPrice) // min seats, no discount
    expect(teamSeatPrice("team_perpetual", 9)).toBe(listPrice) // just below threshold
    expect(teamSeatPrice("team_perpetual", 10)).toBe(89.1) // 10% off 99
    expect(teamSeatPrice("team_perpetual", 25)).toBe(89.1) // 10% off, same per-seat
  })

  it("team_subscription: 10% off at 10+ seats", () => {
    const listPrice = LOCAL_SKU_MAP["team_subscription"]!.priceUsd // 149
    expect(teamSeatPrice("team_subscription", 5)).toBe(listPrice)
    expect(teamSeatPrice("team_subscription", 10)).toBe(134.1) // 10% off 149
  })

  it("teamOrderTotal multiplies the discounted per-seat price by seat count", () => {
    // 10 seats @ 89.10 = 891.00
    expect(teamOrderTotal("team_perpetual", 10)).toBe(891)
    // 25 seats @ 89.10 = 2227.50
    expect(teamOrderTotal("team_perpetual", 25)).toBe(2227.5)
    // below threshold: 9 @ 99 = 891
    expect(teamOrderTotal("team_perpetual", 9)).toBe(891)
  })

  it("teamOrderTotal for one_time SKUs returns the list price regardless of seats", () => {
    expect(teamOrderTotal("individual_launch", 1)).toBe(199)
    expect(teamOrderTotal("individual_regular", 10)).toBe(299)
  })

  it("teamVolumeDiscountPct is 0 below threshold and 10 at/above", () => {
    expect(teamVolumeDiscountPct("team_perpetual", 5)).toBe(0)
    expect(teamVolumeDiscountPct("team_perpetual", TEAM_VOLUME_THRESHOLD)).toBe(
      TEAM_VOLUME_DISCOUNT_PCT
    )
    expect(teamVolumeDiscountPct("individual_launch", 100)).toBe(0)
  })
})
