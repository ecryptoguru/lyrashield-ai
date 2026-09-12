import { describe, expect, it } from "vitest"
import { generateLaunchReportHTML } from "./launch-report-html"

describe("generateLaunchReportHTML", () => {
  it("renders the allowlisted launch payload and escapes customer text", () => {
    const html = generateLaunchReportHTML({
      payloadVersion: "lyrashield-launch-report/2.0.0",
      verdictLabel: "Ready to launch",
      standardVersion: "lyrashield-gate/1.0.0",
      appDisplayName: "<script>alert(1)</script>",
      evaluatedAt: "2026-09-12T00:00:00.000Z",
      issuedAt: "2026-09-12T00:00:00.000Z",
      coverageStatement: ["Repository"],
      nonCoverage: [],
      counts: {
        unresolvedCritical: 0,
        unresolvedHigh: 0,
        unresolvedMedium: 1,
        unresolvedLow: null,
        fixedAndRetestConfirmed: 2,
        independentlyVerified: 1,
      },
      notEvaluatedSeverities: ["LOW"],
      stale: false,
      reportChecksum: "a".repeat(64),
    })

    expect(html).toContain("Ready to launch")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("Not evaluated")
  })
})
