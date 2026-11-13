import { describe, expect, it } from "vitest"
import { partitionControlSignals } from "./tool-result-presentation"

describe("local control presentation", () => {
  it("does not turn clean-file advice into finding actions or erase coverage limits", () => {
    const findings = {
      state: "DETECTED",
      remediation: "Remove the exposed credential",
      file: "app.ts",
    }
    const limitation = {
      state: "INCONCLUSIVE",
      remediation: "Review the truncated file",
      file: "large.ts",
    }
    const signals = [
      findings,
      limitation,
      { state: "NO_FINDING", remediation: "Keep credentials server-side" },
      { state: "NO_FINDING", remediation: "Keep credentials server-side" },
      { state: "NOT_ASSESSED", remediation: "Not scanned" },
    ]
    expect(partitionControlSignals(signals)).toEqual({
      findings: [findings],
      coverage: [limitation],
      guidance: ["Keep credentials server-side"],
    })
  })
})
