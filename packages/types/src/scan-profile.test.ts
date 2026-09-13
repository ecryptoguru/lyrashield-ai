import { describe, expect, it } from "vitest"
import { resolveScanProfile } from "./scan-profile"

describe("resolveScanProfile", () => {
  it("normalizes legacy repository Safe to the requested Quick profile", () => {
    expect(resolveScanProfile({ targetType: "REPO", mode: "SAFE" })).toMatchObject({
      id: "REPO_QUICK",
      canonicalMode: "QUICK",
      engineMode: "quick",
      maxBudgetUsd: 1.2,
      maxDurationMinutes: 15,
      scannerReserveMinutes: 3,
      usesAi: true,
      modelClass: "LUNA",
    })
  })

  it("keeps Standard broader and applies the requested Deep ceiling", () => {
    expect(resolveScanProfile({ targetType: "REPO", mode: "STANDARD" })).toMatchObject({
      id: "REPO_STANDARD",
      engineMode: "standard",
      maxBudgetUsd: 3.2,
      maxDurationMinutes: 15,
    })
    expect(resolveScanProfile({ targetType: "REPO", mode: "DEEP" })).toMatchObject({
      id: "REPO_DEEP",
      engineMode: "deep",
      maxBudgetUsd: 5,
      maxDurationMinutes: 45,
      scannerReserveMinutes: 5,
      modelClass: "TERRA",
    })
  })

  it("canonicalizes URL Quick to its non-destructive Surface Review profile", () => {
    expect(resolveScanProfile({ targetType: "WEB_APP", mode: "QUICK" })).toMatchObject({
      id: "WEB_APP_SAFE",
      canonicalMode: "SAFE",
      maxBudgetUsd: 0,
      usesAi: false,
      engineMode: null,
      label: "Surface Review",
    })
  })

  it("makes URL Standard and Deep engine-backed at repository budgets", () => {
    expect(resolveScanProfile({ targetType: "WEB_APP", mode: "STANDARD" })).toMatchObject({
      id: "WEB_APP_STANDARD",
      canonicalMode: "STANDARD",
      engineMode: "standard",
      maxBudgetUsd: 3.2,
      maxEngineMinutes: 12,
      scannerReserveMinutes: 3,
      usesAi: true,
      modelClass: "LUNA",
      label: "Engine Review",
    })
    expect(resolveScanProfile({ targetType: "WEB_APP", mode: "DEEP" })).toMatchObject({
      id: "WEB_APP_DEEP",
      canonicalMode: "DEEP",
      engineMode: "deep",
      maxBudgetUsd: 5,
      maxEngineMinutes: 40,
      scannerReserveMinutes: 5,
      usesAi: true,
      modelClass: "TERRA",
      label: "Deep Live Review",
    })
    // CUSTOM canonicalizes to DEEP, matching repository scans.
    expect(resolveScanProfile({ targetType: "API", mode: "CUSTOM" })).toMatchObject({
      id: "API_DEEP",
      canonicalMode: "DEEP",
      engineMode: "deep",
      usesAi: true,
    })
  })

  it("rejects unknown and unsupported modes instead of escalating execution", () => {
    expect(() => resolveScanProfile({ targetType: "REPO", mode: "EXPENSIVE" })).toThrow(
      "SCAN_MODE_UNSUPPORTED"
    )
    expect(() => resolveScanProfile({ targetType: "API", mode: "EXPENSIVE" })).toThrow(
      "URL_MODE_UNSUPPORTED"
    )
  })
})
