import { describe, expect, it } from "vitest"
import { getFindingNextAction, getFindingNextStep } from "./finding-next-step"

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

describe("getFindingNextAction (W3-02)", () => {
  it("gives exactly one action per canonical state", () => {
    expect(getFindingNextAction({ hasFixProposal: true, latestRetestStatus: "passed" })).toEqual({
      action: "REPORT",
      reason: expect.stringContaining("passing retest"),
    })
    expect(getFindingNextAction({ hasFixProposal: true, latestRetestStatus: "running" })).toEqual({
      action: "RETEST_IN_PROGRESS",
      reason: expect.stringContaining("running"),
    })
    expect(getFindingNextAction({ hasFixProposal: false, hasEvidence: true })).toEqual({
      action: "INSPECT_EVIDENCE",
      reason: expect.stringContaining("evidence"),
    })
    expect(getFindingNextAction({ hasFixProposal: false, hasEvidence: false })).toEqual({
      action: "FIX_PROPOSAL",
      reason: expect.stringContaining("proposal"),
    })
    expect(getFindingNextAction({ hasFixProposal: true, latestRetestStatus: "failed" })).toEqual({
      action: "RETEST",
      reason: expect.stringContaining("retest"),
    })
  })

  it("never offers an executable action for dispositions", () => {
    for (const status of ["ACCEPTED_RISK", "FALSE_POSITIVE", "DUPLICATE", "FIXED"]) {
      const next = getFindingNextAction({ hasFixProposal: true, status })
      expect(next.action).toBe("NONE")
    }
  })

  it("routes an applied-but-unverified fix to retest, never to FIXED", () => {
    const next = getFindingNextAction({ hasFixProposal: true, status: "FIXED_PENDING_RETEST" })
    expect(next.action).toBe("RETEST")
    expect(next.reason).toMatch(/deterministic retest/)
  })

  it("returns status instead of starting another operation", () => {
    const next = getFindingNextAction({ hasFixProposal: true, operationInFlight: true })
    expect(next.action).toBe("INSPECT_EVIDENCE")
    expect(next.reason).toMatch(/already running/)
  })
})
