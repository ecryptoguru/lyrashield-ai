import { describe, expect, it } from "vitest"
import { generateLaunchReportHTML, isLaunchReportShareablePayload } from "./launch-report-html"
import {
  computeLaunchReportChecksum,
  type LaunchReportShareablePayload,
} from "./launch-report-payload"

function payload(
  overrides: Partial<LaunchReportShareablePayload> = {}
): LaunchReportShareablePayload {
  const value: LaunchReportShareablePayload = {
    payloadVersion: "lyrashield-launch-report/2.0.0",
    verdictLabel: "Ready to launch",
    standardVersion: "lyrashield-gate/1.0.0",
    appDisplayName: "a protected application",
    evaluatedAt: "2026-09-10T00:00:00.000Z",
    assessmentDate: "2026-09-10T00:00:00.000Z",
    expiresAt: "2099-10-10T00:00:00.000Z",
    scopeCommitment: "One target and its retained evidence.",
    issuedAt: "2026-09-10T01:00:00.000Z",
    coverageStatement: ["engine", "secrets"],
    nonCoverage: ["url"],
    counts: {
      unresolvedCritical: 1,
      unresolvedHigh: 2,
      unresolvedMedium: null,
      unresolvedLow: null,
      fixedAndRetestConfirmed: 3,
      independentlyVerified: 4,
    },
    notEvaluatedSeverities: ["MEDIUM", "LOW"],
    dispositionCounts: { acceptedRisk: 1, falsePositive: 2 },
    stale: false,
    reportChecksum: "",
    signature: "signed-value",
    signingKeyId: "launch-readiness-v1",
    ...overrides,
  }
  if (!("reportChecksum" in overrides)) {
    const { reportChecksum, signature, signingKeyId, ...unsigned } = value
    void reportChecksum
    void signature
    void signingKeyId
    value.reportChecksum = computeLaunchReportChecksum(unsigned)
  }
  return value
}

describe("generateLaunchReportHTML", () => {
  it("rejects malformed stored launch snapshots", () => {
    expect(isLaunchReportShareablePayload(payload())).toBe(true)
    expect(isLaunchReportShareablePayload({ ...payload(), payloadVersion: "legacy" })).toBe(false)
    expect(isLaunchReportShareablePayload({ ...payload(), verdictLabel: "Secure" })).toBe(false)
    expect(
      isLaunchReportShareablePayload({
        ...payload(),
        counts: { ...payload().counts, unresolvedMedium: "0" },
      })
    ).toBe(false)
    expect(() =>
      isLaunchReportShareablePayload({ ...payload(), dispositionCounts: null })
    ).not.toThrow()
    expect(isLaunchReportShareablePayload({ ...payload(), dispositionCounts: null })).toBe(false)
    const signedPayload = payload()
    expect(
      isLaunchReportShareablePayload({
        ...signedPayload,
        appDisplayName: "altered after signing",
      })
    ).toBe(false)
    expect(
      isLaunchReportShareablePayload({
        ...payload(),
        dispositionCounts: { acceptedRisk: '<script>alert("x")</script>', falsePositive: 0 },
      })
    ).toBe(false)
  })

  it("renders the frozen aggregate payload without inventing finding detail", () => {
    const html = generateLaunchReportHTML(payload())

    expect(html).toContain("<title>LyraShield Launch Readiness Report</title>")
    expect(html).toContain("Ready to launch")
    expect(html).toContain("Unresolved critical")
    expect(html).toContain(">1<")
    expect(html).toContain("Not evaluated")
    expect(html).toContain("Evaluated: engine, secrets.")
    expect(html).toContain("Not examined: url.")
    expect(html).toContain("signed-value")
    expect(html).toContain("not a guarantee")
    expect(html).not.toContain("Findings Detail")
  })

  it("marks stale verdicts as historical and escapes every payload string", () => {
    const html = generateLaunchReportHTML(
      payload({
        stale: true,
        appDisplayName: '<img src=x onerror="alert(1)">',
        coverageStatement: ["engine<script>alert(1)</script>"],
        nonCoverage: ["url&api"],
      })
    )

    expect(html).toContain("Historical: Ready to launch")
    expect(html).toContain("superseded, expired, or predates current applicability rules")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).toContain("engine&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("url&amp;api")
    expect(html).not.toContain("<script>alert(1)</script>")
  })

  it("marks a report historical once its signed applicability window has expired", () => {
    const html = generateLaunchReportHTML(
      payload({ stale: false, expiresAt: "2020-01-01T00:00:00.000Z" })
    )

    expect(html).toContain("Historical: Ready to launch")
    expect(html).toContain("superseded, expired, or predates current applicability rules")
  })
})
