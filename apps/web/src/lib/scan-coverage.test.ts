import { describe, expect, it } from "vitest"
import { getScannerCoverageWarnings, SCANNER_COVERAGE_EVENT_MESSAGE } from "./scan-coverage"

describe("getScannerCoverageWarnings", () => {
  it("returns complete structured coverage warnings for the scan detail view", () => {
    expect(
      getScannerCoverageWarnings([
        {
          stage: "scanner",
          level: "warning",
          message: SCANNER_COVERAGE_EVENT_MESSAGE,
          metadata: {
            scanner: "sca",
            status: "partial",
            subject: "pom.xml",
            reason: "The dependency version is inherited from an unsupported parent POM.",
          },
        },
      ])
    ).toEqual([
      {
        scanner: "sca",
        status: "partial",
        subject: "pom.xml",
        reason: "The dependency version is inherited from an unsupported parent POM.",
      },
    ])
  })

  it("does not turn unrelated or malformed events into coverage warnings", () => {
    expect(
      getScannerCoverageWarnings([
        {
          stage: "scanner",
          level: "warn",
          message: SCANNER_COVERAGE_EVENT_MESSAGE,
          metadata: { scanner: "sca", status: "partial", reason: "ignored" },
        },
        {
          stage: "scanner",
          level: "warning",
          message: "A different warning",
          metadata: { scanner: "sca", status: "partial", reason: "ignored" },
        },
        {
          stage: "scanner",
          level: "warning",
          message: SCANNER_COVERAGE_EVENT_MESSAGE,
          metadata: { scanner: "sca", status: "partial" },
        },
      ])
    ).toEqual([])
  })
})
