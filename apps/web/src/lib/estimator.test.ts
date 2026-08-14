import { describe, expect, it } from "vitest"
import { estimateRunMinutes } from "./estimator"

describe("estimateRunMinutes", () => {
  it("does not promise a Quick repository scan finishes before its 15-minute cap", () => {
    expect(estimateRunMinutes("QUICK")).toEqual({ low: 5, high: 15 })
    expect(estimateRunMinutes("SAFE")).toEqual({ low: 5, high: 15 })
  })
})
