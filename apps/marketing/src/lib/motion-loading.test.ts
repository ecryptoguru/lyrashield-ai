import { describe, expect, it } from "vitest"
import { canAutoLoadMotion, chapterProgress } from "./motion-loading"

describe("motion download admission", () => {
  it.each([
    undefined,
    {},
    { effectiveType: "4g" },
    { downlink: 20 },
    { effectiveType: "3g", downlink: 10 },
    { effectiveType: "4g", downlink: 4.99 },
    { effectiveType: "4g", downlink: Number.NaN },
    { effectiveType: "4g", downlink: Infinity },
    { effectiveType: "4g", downlink: 5, saveData: true },
  ])("requires explicit play for unknown or constrained hints: %j", (connection) => {
    expect(canAutoLoadMotion(connection)).toBe(false)
  })
  it("allows the supplied 4g threshold and faster connections", () => {
    expect(canAutoLoadMotion({ effectiveType: "4g", downlink: 5 })).toBe(true)
    expect(canAutoLoadMotion({ effectiveType: "4g", downlink: 50 })).toBe(true)
  })
  it("derives chapter progress from the current manifest rather than seven", () => {
    expect(chapterProgress(0, 3)).toBe("01 / 03")
    expect(chapterProgress(9, 12)).toBe("10 / 12")
  })
})
