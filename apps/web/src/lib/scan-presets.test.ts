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

  it("returns Safe, Standard, and Deep web review options", () => {
    const options = getManualScanOptions({ type: "WEB_APP" })
    expect(options.map((o) => o.id)).toEqual(["WEB_APP_SAFE", "WEB_APP_STANDARD", "WEB_APP_DEEP"])
    expect(options[0]).toMatchObject({
      id: "WEB_APP_SAFE",
      label: "Surface Review",
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
      estimate: { low: 1, high: 2 },
      available: true,
    })
    expect(options[1]).toMatchObject({
      id: "WEB_APP_STANDARD",
      label: "Expanded Surface Review",
      mode: "STANDARD",
      goal: "TEST_APP",
      estimate: { low: 4, high: 6 },
      available: true,
    })
    expect(options[2]).toMatchObject({
      id: "WEB_APP_DEEP",
      label: "Behavioral Surface Review",
      mode: "DEEP",
      goal: "FULL_PENTEST",
      estimate: { low: 8, high: 15 },
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

  it("returns Contract and Contract Behavior options for an API target with an OpenAPI spec", () => {
    const options = getManualScanOptions({ type: "API", hasApiSpec: true })
    expect(options.map((o) => o.id)).toEqual(["API_SAFE", "API_STANDARD", "API_DEEP"])
    expect(options[0]).toMatchObject({
      id: "API_SAFE",
      label: "Endpoint Review",
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
      estimate: { low: 1, high: 2 },
      available: true,
    })
    expect(options[1]).toMatchObject({
      id: "API_STANDARD",
      label: "Contract Review",
      mode: "STANDARD",
      goal: "TEST_APP",
      estimate: { low: 2, high: 4 },
      available: true,
    })
    expect(options[2]).toMatchObject({
      id: "API_DEEP",
      label: "Contract Behavior Review",
      mode: "DEEP",
      goal: "FULL_PENTEST",
      estimate: { low: 4, high: 8 },
      available: true,
    })
  })

  it("returns the repository fallback for unknown target types", () => {
    const options = getManualScanOptions({ type: "CLOUD_ACCOUNT" })
    expect(options.map((o) => o.id)).toEqual(["RELEASE_CHECK", "CODE_REVIEW", "DEEP_REVIEW"])
  })
})
