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

  it("does not describe the Quick repository preset as a changed-files review", () => {
    // Quick scans the submitted repository snapshot. "Changed files" is the
    // Review Changes workflow's vocabulary, not the Quick depth's.
    for (const copy of [
      SCAN_PRESETS.RELEASE_CHECK.label,
      SCAN_PRESETS.RELEASE_CHECK.description,
      SCAN_PRESETS.RELEASE_CHECK.hint,
    ]) {
      expect(copy.toLowerCase()).not.toContain("changed files")
    }
  })

  it("maps each review type to its user-facing duration range", () => {
    expect(getScanPresetEstimate("RELEASE_CHECK")).toEqual({ low: 5, high: 22 })
    expect(getScanPresetEstimate("CODE_REVIEW")).toEqual({ low: 12, high: 23 })
    expect(getScanPresetEstimate("DEEP_REVIEW")).toEqual({ low: 25, high: 45 })
    expect(getScanPresetEstimate("WEEKLY_MONITOR")).toEqual({ low: 5, high: 22 })
  })

  it("describes engine ceilings without counting scanner reserve as engine time", () => {
    const repoOptions = getManualScanOptions({ type: "REPO" })
    expect(repoOptions.find((option) => option.id === "RELEASE_CHECK")?.limitsSummary).toBe(
      "Up to 20 minutes of engine time"
    )
    expect(repoOptions.find((option) => option.id === "CODE_REVIEW")?.limitsSummary).toBe(
      "Up to 20 minutes of engine time"
    )
    expect(repoOptions.find((option) => option.id === "REVIEW_CHANGES")?.limitsSummary).toBe(
      "Up to 20 minutes of engine time"
    )
    expect(repoOptions.find((option) => option.id === "DEEP_REVIEW")?.limitsSummary).toBe(
      "Up to 40 minutes of engine time"
    )
    const urlSafe = getManualScanOptions({ type: "WEB_APP" })[0]
    expect(urlSafe?.limitsSummary).toBe("Bounded deterministic checks only")
  })

  it("falls back to the release check for unknown client values", () => {
    expect(getScanPreset("unknown")).toBe(SCAN_PRESETS.RELEASE_CHECK)
  })
})

describe("getManualScanOptions", () => {
  it("returns the repository review options for a repo target", () => {
    const options = getManualScanOptions({ type: "REPO" })
    expect(options.map((o) => o.id)).toEqual([
      "RELEASE_CHECK",
      "CODE_REVIEW",
      "REVIEW_CHANGES",
      "DEEP_REVIEW",
      "CODE_REVIEW_LAUNCH_REVIEW",
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
    // URL/API launch is deterministic-only: no engine-backed option exists, so
    // no option may carry an engine authorization hint.
    for (const option of getManualScanOptions({ type: "WEB_APP" })) {
      expect(option.usesAi).toBe(false)
      expect(option.authorizationHint).toBeUndefined()
    }
    // No preset copy may claim certification or guaranteed detection.
    for (const option of getManualScanOptions({ type: "REPO" })) {
      expect(`${option.label} ${option.description} ${option.hint}`).not.toMatch(
        /certif|guarantee|universal|compliant/i
      )
    }
  })

  it("returns only the deterministic Safe web review option", () => {
    const options = getManualScanOptions({ type: "WEB_APP" })
    expect(options.map((o) => o.id)).toEqual(["WEB_APP_SAFE"])
    expect(options[0]).toMatchObject({
      id: "WEB_APP_SAFE",
      label: "Surface Review",
      mode: "SAFE",
      goal: "LAUNCH_REVIEW",
      estimate: { low: 1, high: 2 },
      usesAi: false,
      available: true,
      applicableChecks: ["Public surface checks"],
    })
  })

  it("shows Endpoint Review plus locked guidance for an API target without an OpenAPI spec", () => {
    const options = getManualScanOptions({ type: "API" })
    expect(options.map((o) => ({ id: o.id, available: o.available }))).toEqual([
      { id: "API_SAFE", available: true },
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

  it("returns only the deterministic endpoint option for an API target with an OpenAPI spec", () => {
    const options = getManualScanOptions({ type: "API", hasApiSpec: true })
    expect(options.map((o) => o.id)).toEqual(["API_SAFE"])
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

  it("returns the repository fallback for unknown target types", () => {
    const options = getManualScanOptions({ type: "CLOUD_ACCOUNT" })
    expect(options.map((o) => o.id)).toEqual([
      "RELEASE_CHECK",
      "CODE_REVIEW",
      "REVIEW_CHANGES",
      "DEEP_REVIEW",
      "CODE_REVIEW_LAUNCH_REVIEW",
    ])
  })
})
