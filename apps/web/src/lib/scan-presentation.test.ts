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

  it("names explicit failure causes truthfully — never a clean score", () => {
    const cases: Array<[string, string]> = [
      ["NO_ANALYZABLE_CHANGES", "No analyzable changes"],
      ["SCAN_SOURCE_UNAVAILABLE", "Source unavailable"],
      ["SCAN_NO_MERGE_BASE", "Source unavailable"],
      ["RELAY_SCOPE_UNAVAILABLE", "Authorization unavailable"],
      ["AUTHORIZATION_REVOKED", "Authorization unavailable"],
      ["EVIDENCE_STORAGE_CONFIGURATION", "Evidence export failed"],
      ["SCAN_ATTACHMENT_UNAVAILABLE", "Supporting file unavailable"],
      ["SCAN_ATTACHMENT_CHECKSUM_MISMATCH", "Supporting file unavailable"],
      ["PROMPT_INJECTION", "Unsupported input"],
      ["UNSUPPORTED_CHECKS", "Unsupported checks"],
    ]
    for (const [errorCategory, label] of cases) {
      const presentation = getScanPresentation("FAILED", { errorCategory })
      expect(presentation.label, errorCategory).toBe(label)
      // Every named failure stays non-assuring — an incomplete scan never
      // presents as a clean security score.
      expect(presentation.assuranceAvailable, errorCategory).toBe(false)
    }
  })

  it("keeps queued and running states non-assuring", () => {
    for (const status of ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"]) {
      expect(getScanPresentation(status).assuranceAvailable).toBe(false)
    }
    expect(getScanPresentation("COMPLETED").assuranceAvailable).toBe(true)
    expect(getScanPresentation("TIMED_OUT").assuranceAvailable).toBe(false)
    expect(getScanPresentation("CANCELLED").assuranceAvailable).toBe(false)
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
