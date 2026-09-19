import { describe, expect, it } from "vitest"
import {
  getScanPreset,
  getScanPresetEstimate,
  getManualScanOptions,
  getDefaultScanOptionId,
  SCAN_PRESETS,
} from "./scan-presets"

describe("scan presets", () => {
  it("binds each user-facing choice to one safe goal and mode", () => {
    expect(SCAN_PRESETS.RELEASE_CHECK).toMatchObject({ goal: "LAUNCH_REVIEW", mode: "QUICK" })
    expect(SCAN_PRESETS.CODE_REVIEW).toMatchObject({ goal: "TEST_APP", mode: "STANDARD" })
    expect(SCAN_PRESETS.DEEP_REVIEW).toMatchObject({ goal: "FULL_PENTEST", mode: "DEEP" })
  })

  it("maps each review type to its user-facing duration range", () => {
    expect(getScanPresetEstimate("RELEASE_CHECK")).toEqual({ low: 5, high: 15 })
    expect(getScanPresetEstimate("CODE_REVIEW")).toEqual({ low: 8, high: 15 })
    expect(getScanPresetEstimate("DEEP_REVIEW")).toEqual({ low: 25, high: 40 })
    expect(getScanPresetEstimate("WEEKLY_MONITOR")).toEqual({ low: 5, high: 15 })
  })

  it("falls back to the release check for unknown client values", () => {
    expect(getScanPreset("unknown")).toBe(SCAN_PRESETS.RELEASE_CHECK)
  })
})

describe("getManualScanOptions", () => {
  it("returns the repository review options for a repo target", () => {
    const options = getManualScanOptions({ type: "REPO" })
    expect(options.map((o) => o.id)).toEqual([
      "CODE_REVIEW",
      "RELEASE_CHECK",
      "REVIEW_CHANGES",
      "DEEP_REVIEW",
    ])
    expect(options.every((o) => o.available)).toBe(true)
    expect(options.every((option) => !Object.hasOwn(option, "maxBudgetUsd"))).toBe(true)
  })

  it("defaults repository review to the Standard-depth code review", () => {
    const options = getManualScanOptions({ type: "REPO" })
    expect(getDefaultScanOptionId(options)).toBe("CODE_REVIEW")
    const option = options.find((o) => o.id === "CODE_REVIEW")
    expect(option).toMatchObject({ mode: "STANDARD", workflow: "REVIEW_TARGET" })
  })

  it("defaults Review Changes to Quick and requires immutable revision inputs", () => {
    const options = getManualScanOptions({ type: "REPO" })
    const option = options.find((o) => o.id === "REVIEW_CHANGES")
    expect(option).toMatchObject({
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      requiresRevisionInputs: true,
      available: true,
    })
  })

  it("exposes truthful scope, limits, checks, and authorization metadata", () => {
    for (const option of getManualScanOptions({ type: "REPO" })) {
      expect(option.scopeSummary.length).toBeGreaterThan(0)
      expect(option.limitsSummary.length).toBeGreaterThan(0)
      expect(option.applicableChecks.length).toBeGreaterThan(0)
      // No provider/model cost may ever leak into creation UX.
      expect(option.limitsSummary).not.toMatch(/\$|USD|cost/i)
    }
    const engineBackedUrl = getManualScanOptions({ type: "WEB_APP" }).find(
      (o) => o.id === "WEB_APP_STANDARD"
    )
    expect(engineBackedUrl?.authorizationHint).toContain("verified domain")
    // No preset copy may claim certification or guaranteed detection.
    for (const option of getManualScanOptions({ type: "REPO" })) {
      expect(`${option.label} ${option.description} ${option.hint}`).not.toMatch(
        /certif|guarantee|universal|compliant/i
      )
    }
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
      usesAi: false,
      available: true,
    })
    expect(options[1]).toMatchObject({
      id: "WEB_APP_STANDARD",
      label: "Engine Review",
      mode: "STANDARD",
      goal: "TEST_APP",
      estimate: { low: 8, high: 15 },
      usesAi: true,
      available: true,
    })
    expect(options[2]).toMatchObject({
      id: "WEB_APP_DEEP",
      label: "Deep Live Review",
      mode: "DEEP",
      goal: "FULL_PENTEST",
      estimate: { low: 25, high: 40 },
      usesAi: true,
      available: true,
    })
  })

  it("shows Endpoint Review plus locked guidance for an API target without an OpenAPI spec", () => {
    const options = getManualScanOptions({ type: "API" })
    expect(options.map((o) => ({ id: o.id, available: o.available }))).toEqual([
      { id: "API_SAFE", available: true },
      { id: "API_STANDARD", available: false },
      { id: "API_DEEP", available: false },
    ])
    expect(options[0]).toMatchObject({
      id: "API_SAFE",
      label: "Endpoint Review",
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
      estimate: { low: 1, high: 2 },
      usesAi: false,
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
      usesAi: false,
      available: true,
    })
    expect(options[1]).toMatchObject({
      id: "API_STANDARD",
      label: "Engine Contract Review",
      mode: "STANDARD",
      goal: "TEST_APP",
      estimate: { low: 8, high: 15 },
      usesAi: true,
      available: true,
    })
    expect(options[2]).toMatchObject({
      id: "API_DEEP",
      label: "Deep Contract Review",
      mode: "DEEP",
      goal: "FULL_PENTEST",
      estimate: { low: 25, high: 40 },
      usesAi: true,
      available: true,
    })
  })

  it("returns the repository fallback for unknown target types", () => {
    const options = getManualScanOptions({ type: "CLOUD_ACCOUNT" })
    expect(options.map((o) => o.id)).toEqual([
      "CODE_REVIEW",
      "RELEASE_CHECK",
      "REVIEW_CHANGES",
      "DEEP_REVIEW",
    ])
  })
})
