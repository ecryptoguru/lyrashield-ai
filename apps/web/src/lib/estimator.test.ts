import { describe, expect, it } from "vitest"
import { estimateRunMinutes } from "./estimator"

describe("estimateRunMinutes", () => {
  it("reflects the total runtime ceilings for all four repository scan depths", () => {
    expect(estimateRunMinutes("QUICK")).toEqual({ low: 5, high: 22 })
    expect(estimateRunMinutes("SAFE")).toEqual({ low: 5, high: 22 })
    expect(estimateRunMinutes("STANDARD")).toEqual({ low: 12, high: 23 })
    expect(estimateRunMinutes("DEEP")).toEqual({ low: 25, high: 45 })
    expect(estimateRunMinutes("CUSTOM")).toEqual({ low: 20, high: 45 })
  })
})
