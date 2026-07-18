import { describe, expect, it } from "vitest"
import { getFindingNextStep } from "./finding-next-step"

describe("getFindingNextStep", () => {
  it.each([
    [{ latestRetestStatus: "passed", hasFixProposal: true }, "REPORT"],
    [{ latestRetestStatus: "running", hasFixProposal: true }, "RETEST_IN_PROGRESS"],
    [{ latestRetestStatus: null, hasFixProposal: false }, "FIX_PROPOSAL"],
    [{ latestRetestStatus: "failed", hasFixProposal: true }, "RETEST"],
  ] as const)("returns the guided action for %o", (input, expected) => {
    expect(getFindingNextStep(input)).toBe(expected)
  })
})
