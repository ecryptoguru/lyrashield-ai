import { describe, expect, it } from "vitest"
import { getScanPreset, getScanPresetEstimate, SCAN_PRESETS } from "./scan-presets"

describe("scan presets", () => {
  it("binds each user-facing choice to one safe goal and mode", () => {
    expect(SCAN_PRESETS.RELEASE_CHECK).toMatchObject({ goal: "LAUNCH_REVIEW", mode: "SAFE" })
    expect(SCAN_PRESETS.CODE_REVIEW).toMatchObject({ goal: "TEST_APP", mode: "STANDARD" })
    expect(SCAN_PRESETS.DEEP_REVIEW).toMatchObject({ goal: "FULL_PENTEST", mode: "DEEP" })
  })

  it("maps each review type to its user-facing duration range", () => {
    expect(getScanPresetEstimate("RELEASE_CHECK")).toEqual({ low: 5, high: 8 })
    expect(getScanPresetEstimate("CODE_REVIEW")).toEqual({ low: 8, high: 15 })
    expect(getScanPresetEstimate("DEEP_REVIEW")).toEqual({ low: 25, high: 40 })
    expect(getScanPresetEstimate("WEEKLY_MONITOR")).toEqual({ low: 5, high: 8 })
  })

  it("falls back to the release check for unknown client values", () => {
    expect(getScanPreset("unknown")).toBe(SCAN_PRESETS.RELEASE_CHECK)
  })
})
