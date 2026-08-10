import { describe, expect, it } from "vitest"
import {
  getScanPreset,
  getScanPresetEstimate,
  getManualScanOptions,
  SCAN_PRESETS,
} from "./scan-presets"

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

describe("getManualScanOptions", () => {
  it("returns the three repository review options for a repo target", () => {
    const options = getManualScanOptions({ type: "REPO" })
    expect(options.map((o) => o.id)).toEqual(["RELEASE_CHECK", "CODE_REVIEW", "DEEP_REVIEW"])
    expect(options.every((o) => o.available)).toBe(true)
  })

  it("returns only Surface Review for a web target until deeper modes release", () => {
    const options = getManualScanOptions({ type: "WEB_APP" })
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      id: "WEB_APP_SAFE",
      label: "Surface Review",
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
      estimate: { low: 1, high: 2 },
      available: true,
    })
  })

  it("returns only Endpoint Review for an API target without an OpenAPI spec", () => {
    const options = getManualScanOptions({ type: "API" })
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      id: "API_SAFE",
      label: "Endpoint Review",
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
      estimate: { low: 1, high: 2 },
      available: true,
    })
  })

  it("returns the repository fallback for unknown target types", () => {
    const options = getManualScanOptions({ type: "CLOUD_ACCOUNT" })
    expect(options.map((o) => o.id)).toEqual(["RELEASE_CHECK", "CODE_REVIEW", "DEEP_REVIEW"])
  })
})
