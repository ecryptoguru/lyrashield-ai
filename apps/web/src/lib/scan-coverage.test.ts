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

  it("keeps bounded discovery counts and safe skipped-path samples", () => {
    expect(
      getScannerCoverageWarnings([
        {
          stage: "scanner",
          level: "warning",
          message: SCANNER_COVERAGE_EVENT_MESSAGE,
          metadata: {
            scanner: "ai_app_security",
            status: "bounded",
            reason: "AI App Security file limit reached",
            metadata: {
              eligibleFiles: 217,
              scannedFiles: 200,
              skippedFiles: 17,
              representativeSkippedPaths: ["tests/unit/urlSafety.test.ts", 42],
            },
          },
        },
      ])
    ).toEqual([
      {
        scanner: "ai_app_security",
        status: "bounded",
        reason: "AI App Security file limit reached",
        discovery: {
          eligibleFiles: 217,
          scannedFiles: 200,
          skippedFiles: 17,
          representativeSkippedPaths: ["tests/unit/urlSafety.test.ts"],
        },
      },
    ])
  })
})
