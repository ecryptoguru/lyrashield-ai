import { describe, expect, it } from "vitest"
import {
  SCAN_STATE_FILTERS,
  getScanPresentation,
  isActiveScan,
  parseScanStateFilter,
  scanStateStatusLabel,
  scanStateStatuses,
} from "./scan-presentation"

describe("scan presentation", () => {
  it("keeps failure and partial runs distinct from completed results", () => {
    expect(getScanPresentation("FAILED")).toMatchObject({
      assuranceAvailable: false,
      headline: "Scan failed",
    })
    expect(getScanPresentation("PARTIAL")).toMatchObject({
      assuranceAvailable: false,
      badgeVariant: "warning",
      showFailureDetails: true,
    })
  })

  it("keeps active worker states distinct from terminal states", () => {
    expect(isActiveScan("RUNNING")).toBe(true)
    expect(isActiveScan("PARTIAL")).toBe(false)
    expect(isActiveScan("FAILED")).toBe(false)
  })

  it("routes exhausted agent minutes to usage, not a generic retry", () => {
    expect(
      getScanPresentation("STOPPED_BUDGET", {
        errorCategory: "AGENT_MINUTES_EXHAUSTED",
      })
    ).toMatchObject({ label: "Minutes exhausted", recoveryAction: "usage" })
  })
})

describe("scan state filters", () => {
  it("maps each state to its documented statuses", () => {
    expect(scanStateStatuses("ACTIVE")).toEqual([
      "QUEUED",
      "PREFLIGHT",
      "RUNNING",
      "VERIFYING",
      "REQUIRES_APPROVAL",
    ])
    expect(scanStateStatuses("COMPLETED")).toEqual(["COMPLETED", "PARTIAL"])
    expect(scanStateStatuses("NEEDS_ATTENTION")).toEqual(["FAILED", "STOPPED_BUDGET", "TIMED_OUT"])
    expect(scanStateStatuses("CANCELLED")).toEqual(["CANCELLED"])
    expect(scanStateStatuses("ALL")).toBeNull()
  })

  it("falls back to ALL for unknown or missing values", () => {
    expect(parseScanStateFilter(undefined)).toBe("ALL")
    expect(parseScanStateFilter(null)).toBe("ALL")
    expect(parseScanStateFilter("DROP TABLE")).toBe("ALL")
    expect(parseScanStateFilter("ACTIVE")).toBe("ACTIVE")
  })

  it("exposes exactly the documented filter set", () => {
    expect(SCAN_STATE_FILTERS).toEqual([
      "ALL",
      "ACTIVE",
      "COMPLETED",
      "NEEDS_ATTENTION",
      "CANCELLED",
    ])
  })

  it("labels every filter option", () => {
    for (const state of SCAN_STATE_FILTERS) {
      expect(scanStateStatusLabel(state)).toBeTruthy()
    }
    expect(scanStateStatusLabel("NEEDS_ATTENTION")).toBe("Needs attention")
  })
})
