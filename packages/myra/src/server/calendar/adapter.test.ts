import "../test-env"
import { describe, expect, it } from "vitest"
import { zonedParts, zonedWallToUtc } from "./adapter"

describe("zonedWallToUtc", () => {
  it("converts Asia/Kolkata wall time to UTC (UTC+5:30, no DST)", () => {
    expect(zonedWallToUtc("2026-09-21", 15 * 60, "Asia/Kolkata").toISOString()).toBe(
      "2026-09-21T09:30:00.000Z"
    )
    expect(zonedWallToUtc("2026-09-21", 20 * 60, "Asia/Kolkata").toISOString()).toBe(
      "2026-09-21T14:30:00.000Z"
    )
  })

  it("handles a DST-observing zone correctly", () => {
    // 2026-07-01 is EDT (UTC-4).
    expect(zonedWallToUtc("2026-07-01", 9 * 60, "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z"
    )
  })
})

describe("zonedParts", () => {
  it("returns date, weekday and minutes in the zone", () => {
    const p = zonedParts(new Date("2026-09-21T09:30:00.000Z"), "Asia/Kolkata")
    expect(p.date).toBe("2026-09-21")
    expect(p.weekday).toBe("Mon")
    expect(p.minutes).toBe(900)
  })
})
