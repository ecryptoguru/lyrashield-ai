import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import type { LaunchReportShareablePayload } from "@lyrashield/db"
import { SharedLaunchReportView } from "./launch-report-view"

it("clearly presents an unconfirmed retained READY as historical", () => {
  const payload: LaunchReportShareablePayload = {
    payloadVersion: "lyrashield-launch-report/2.0.0",
    verdictLabel: "Ready to launch",
    standardVersion: "lyrashield-gate/2.4.0",
    appDisplayName: "Protected app",
    evaluatedAt: "2026-11-12T00:00:00Z",
    issuedAt: "2026-11-12T00:01:00Z",
    coverageStatement: [],
    nonCoverage: [],
    counts: {
      unresolvedCritical: 0,
      unresolvedHigh: 0,
      unresolvedMedium: 0,
      unresolvedLow: 0,
      fixedAndRetestConfirmed: 1,
      independentlyVerified: 0,
    },
    notEvaluatedSeverities: [],
    stale: true,
    reportChecksum: "abc",
  }
  const html = renderToStaticMarkup(<SharedLaunchReportView payload={payload} />)
  expect(html).toContain("Historical: Ready to launch")
  expect(html).toContain("could not be confirmed against retained evidence")
  expect(html).toContain("run a current gate assessment")
})
