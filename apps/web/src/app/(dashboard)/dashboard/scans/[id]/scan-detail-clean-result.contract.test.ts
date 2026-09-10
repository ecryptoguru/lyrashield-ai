import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// apps/web has no component test harness; preserve the clean-result action contract here.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("./scan-detail-client.tsx", import.meta.url), "utf8")

describe("completed clean-result payoff", () => {
  it("keeps report and scorecard actions exclusive to completed scans", () => {
    expect(source).toContain('scan.status === "COMPLETED" && (')
    expect(source).toContain("Generate report")
    expect(source).toContain("<ScorecardControls")
    expect(source).toContain("Absence of findings is not verification.")
  })
})
