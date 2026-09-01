import { describe, expect, it } from "vitest"

import {
  buildLaunchReportPayload,
  computeLaunchReportChecksum,
  NEUTRAL_APP_LABEL,
  LAUNCH_REPORT_PAYLOAD_VERSION,
  type LaunchReportSource,
} from "./launch-report-payload"

function verdict(overrides: Partial<LaunchReportSource> = {}): LaunchReportSource {
  return {
    standardVersion: "lyrashield-gate/1.0.0",
    state: "READY",
    coverageStatement: ["engine", "sca", "secrets"],
    nonCoverage: [],
    blockingReasons: [],
    evidenceSummary: { verified: 4, retestConfirmed: 2 },
    staleness: { current: true },
    verdictChecksum: "abc",
    evaluatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  }
}

describe("buildLaunchReportPayload — the disclosure allowlist", () => {
  it("emits exactly the allowed key set (regression guard)", () => {
    const payload = buildLaunchReportPayload(verdict())
    expect(Object.keys(payload).sort()).toEqual([
      "appDisplayName",
      "counts",
      "coverageStatement",
      "evaluatedAt",
      "issuedAt",
      "nonCoverage",
      "payloadVersion",
      "reportChecksum",
      "stale",
      "standardVersion",
      "verdictLabel",
    ])
  })

  it("counts carries only the aggregate bands (no finding detail)", () => {
    const payload = buildLaunchReportPayload(verdict())
    expect(Object.keys(payload.counts).sort()).toEqual([
      "fixedAndRetestConfirmed",
      "independentlyVerified",
      "unresolvedCritical",
      "unresolvedHigh",
      "unresolvedLow",
      "unresolvedMedium",
    ])
  })

  it("defaults the app to the neutral label (founder ruling)", () => {
    expect(buildLaunchReportPayload(verdict()).appDisplayName).toBe(NEUTRAL_APP_LABEL)
  })

  it("shows a customer-opted-in app name only when provided", () => {
    expect(
      buildLaunchReportPayload(verdict(), { appDisplayName: "Acme Shop" }).appDisplayName
    ).toBe("Acme Shop")
    // Blank/whitespace opt-in falls back to neutral.
    expect(buildLaunchReportPayload(verdict(), { appDisplayName: "   " }).appDisplayName).toBe(
      NEUTRAL_APP_LABEL
    )
  })

  it("maps the verdict state to customer-facing phrasing", () => {
    expect(buildLaunchReportPayload(verdict({ state: "READY" })).verdictLabel).toBe(
      "Ready to launch"
    )
    expect(buildLaunchReportPayload(verdict({ state: "NOT_READY" })).verdictLabel).toBe("Not ready")
    expect(buildLaunchReportPayload(verdict({ state: "INSUFFICIENT_EVIDENCE" })).verdictLabel).toBe(
      "Not enough evidence"
    )
  })

  it("discloses non-coverage as scanner names only (never the operational why)", () => {
    const payload = buildLaunchReportPayload(
      verdict({
        nonCoverage: [
          {
            controlId: "secrets",
            scanner: "secrets",
            reason: "blocked: checkout path /internal/secret-path unreachable",
          },
        ],
      })
    )
    // The reason (which leaks an internal path) must NOT appear — only the scanner name.
    expect(payload.nonCoverage).toEqual(["secrets"])
    expect(JSON.stringify(payload)).not.toContain("internal/secret-path")
  })

  it("never leaks a finding title, file path, or CWE into the payload", () => {
    const payload = buildLaunchReportPayload(
      verdict({
        blockingReasons: [{ severity: "CRITICAL" }, { severity: "HIGH" }],
      })
    )
    const json = JSON.stringify(payload)
    for (const banned of ["findingId", "filePath", "cwe", ".ts", "src/"]) {
      expect(json).not.toContain(banned)
    }
    expect(payload.counts.unresolvedCritical).toBe(1)
    expect(payload.counts.unresolvedHigh).toBe(1)
  })

  it("marks stale when the verdict is not current", () => {
    expect(buildLaunchReportPayload(verdict({ staleness: { current: false } })).stale).toBe(true)
  })

  it("records the standard and payload versions", () => {
    const payload = buildLaunchReportPayload(verdict())
    expect(payload.standardVersion).toBe("lyrashield-gate/1.0.0")
    expect(payload.payloadVersion).toBe(LAUNCH_REPORT_PAYLOAD_VERSION)
  })
})

describe("computeLaunchReportChecksum — tamper-evidence", () => {
  it("is deterministic for identical input", () => {
    const a = buildLaunchReportPayload(verdict(), { issuedAt: new Date("2026-09-01") })
    expect(a.reportChecksum).toBe(
      computeLaunchReportChecksum({ ...a, reportChecksum: undefined } as never)
    )
  })

  it("changes when the verdict changes", () => {
    const ready = buildLaunchReportPayload(verdict(), { issuedAt: new Date("2026-09-01") })
    const notReady = buildLaunchReportPayload(verdict({ state: "NOT_READY" }), {
      issuedAt: new Date("2026-09-01"),
    })
    expect(ready.reportChecksum).not.toBe(notReady.reportChecksum)
  })
})
