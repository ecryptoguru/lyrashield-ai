import { describe, expect, it } from "vitest"
import { getScanPresentation, isActiveScan } from "./scan-presentation"

describe("scan presentation", () => {
  it("does not describe a failed scan as a completed result", () => {
    const presentation = getScanPresentation("FAILED")

    expect(presentation.assuranceAvailable).toBe(false)
    expect(presentation.headline).toBe("Scan failed")
    expect(presentation.description).toContain("No assurance result")
  })

  it("keeps active worker states distinct from terminal states", () => {
    expect(isActiveScan("RUNNING")).toBe(true)
    expect(isActiveScan("FAILED")).toBe(false)
  })

  it("describes a partial scan as incomplete, not completed", () => {
    const presentation = getScanPresentation("PARTIAL")

    expect(presentation.assuranceAvailable).toBe(false)
    expect(presentation.badgeVariant).toBe("warning")
    expect(presentation.label).toBe("Partial")
    expect(presentation.headline).toContain("gaps")
    expect(presentation.description).toContain("incomplete")
    expect(presentation.showFailureDetails).toBe(true)
  })

  it("does not treat PARTIAL as an active scan", () => {
    expect(isActiveScan("PARTIAL")).toBe(false)
  })

  it("routes current and legacy minute exhaustion to usage instead of retry", () => {
    const current = getScanPresentation("STOPPED_BUDGET", {
      errorCategory: "AGENT_MINUTES_EXHAUSTED",
    })
    const legacy = getScanPresentation("STOPPED_BUDGET", {
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Agent-minute balance exhausted and grace period exceeded",
    })

    expect(current).toMatchObject({ label: "Minutes exhausted", recoveryAction: "usage" })
    expect(legacy).toMatchObject({ label: "Minutes exhausted", recoveryAction: "usage" })
    expect(current.description).toContain("before starting another model-backed scan")
  })

  it("keeps the protected model-cost limit distinct from minute exhaustion", () => {
    const presentation = getScanPresentation("STOPPED_BUDGET", {
      errorCategory: "BUDGET_EXCEEDED",
      errorMessage: "Protected run limit reached",
    })

    expect(presentation.label).toBe("Stopped by budget")
    expect(presentation.recoveryAction).toBeUndefined()
  })
})
