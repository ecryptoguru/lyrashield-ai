import { describe, expect, it } from "vitest"
import { addMonthsClamped, isWithinPaidTerm, resolveAllowanceCycle } from "./allowance-cycle"

const anchor = new Date("2026-01-15T10:00:00.000Z")

describe("resolveAllowanceCycle — monthly plans", () => {
  it("returns the provider period as the cycle", () => {
    const cycle = resolveAllowanceCycle({
      interval: "monthly",
      periodStart: anchor,
      periodEnd: new Date("2026-02-15T10:00:00.000Z"),
      at: new Date("2026-09-01T00:00:00.000Z"),
    })
    expect(cycle.cycleStart).toEqual(anchor)
    expect(cycle.cycleEnd).toEqual(new Date("2026-02-15T10:00:00.000Z"))
  })
})

describe("resolveAllowanceCycle — annual plans", () => {
  const termEnd = new Date("2027-01-15T10:00:00.000Z")

  it("grants the first monthly cycle at the term anchor", () => {
    const cycle = resolveAllowanceCycle({
      interval: "annual",
      periodStart: anchor,
      periodEnd: termEnd,
      at: new Date("2026-01-20T00:00:00.000Z"),
    })
    expect(cycle.cycleStart).toEqual(anchor)
    expect(cycle.cycleEnd).toEqual(new Date("2026-02-15T10:00:00.000Z"))
  })

  it("advances to the monthly anniversary containing `at`", () => {
    const cycle = resolveAllowanceCycle({
      interval: "annual",
      periodStart: anchor,
      periodEnd: termEnd,
      at: new Date("2026-08-20T00:00:00.000Z"),
    })
    expect(cycle.cycleStart).toEqual(new Date("2026-08-15T10:00:00.000Z"))
    expect(cycle.cycleEnd).toEqual(new Date("2026-09-15T10:00:00.000Z"))
  })

  it("clamps the final cycle to the term end", () => {
    const cycle = resolveAllowanceCycle({
      interval: "annual",
      periodStart: anchor,
      periodEnd: termEnd,
      at: new Date("2027-01-10T00:00:00.000Z"),
    })
    expect(cycle.cycleStart).toEqual(new Date("2026-12-15T10:00:00.000Z"))
    expect(cycle.cycleEnd).toEqual(termEnd)
  })

  it("does not drift on a month-end anchor (Jan 31 → Feb 28 → Mar 31)", () => {
    const monthEndAnchor = new Date("2026-01-31T10:00:00.000Z")
    const feb = resolveAllowanceCycle({
      interval: "annual",
      periodStart: monthEndAnchor,
      periodEnd: new Date("2027-01-31T10:00:00.000Z"),
      at: new Date("2026-03-01T00:00:00.000Z"),
    })
    expect(feb.cycleStart).toEqual(new Date("2026-02-28T10:00:00.000Z"))
    // Anchor day (31) is preserved for later months — never chains Feb 28 → Mar 28.
    const mar = resolveAllowanceCycle({
      interval: "annual",
      periodStart: monthEndAnchor,
      periodEnd: new Date("2027-01-31T10:00:00.000Z"),
      at: new Date("2026-04-01T00:00:00.000Z"),
    })
    expect(mar.cycleStart).toEqual(new Date("2026-03-31T10:00:00.000Z"))
  })

  it("produces twelve distinct cycles across the annual term", () => {
    const starts = new Set<string>()
    for (let month = 0; month < 12; month += 1) {
      const at = addMonthsClamped(anchor, month)
      const cycle = resolveAllowanceCycle({
        interval: "annual",
        periodStart: anchor,
        periodEnd: termEnd,
        at,
      })
      starts.add(cycle.cycleStart.toISOString())
    }
    expect(starts.size).toBe(12)
  })
})

describe("isWithinPaidTerm", () => {
  it("is false past the term end and before the anchor", () => {
    const input = {
      interval: "annual" as const,
      periodStart: anchor,
      periodEnd: new Date("2027-01-15T10:00:00.000Z"),
    }
    expect(isWithinPaidTerm({ ...input, at: new Date("2026-01-14T00:00:00.000Z") })).toBe(false)
    expect(isWithinPaidTerm({ ...input, at: new Date("2027-01-15T10:00:00.000Z") })).toBe(false)
    expect(isWithinPaidTerm({ ...input, at: new Date("2026-06-15T10:00:00.000Z") })).toBe(true)
  })
})
