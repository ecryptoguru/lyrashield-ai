import { describe, expect, it } from "vitest"
import { getTrendPointX } from "./security-visuals.utils"

describe("ScoreTrend positioning", () => {
  it("centers a single score instead of pinning it to the chart edge", () => {
    expect(getTrendPointX(0, 1, 560, 18)).toBe(280)
  })

  it("spreads multiple scores across the usable chart width", () => {
    expect([0, 1, 2].map((index) => getTrendPointX(index, 3, 560, 18))).toEqual([18, 280, 542])
  })
})
