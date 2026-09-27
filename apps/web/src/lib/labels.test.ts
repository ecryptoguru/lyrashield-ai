import { describe, expect, it } from "vitest"
import { evidenceTypeLabel, getGoalLabel, humanizeToken, modeLabel } from "./labels"

describe("customer-facing labels", () => {
  it("renders known values and readable fallbacks", () => {
    expect(getGoalLabel("LAUNCH_REVIEW")).toBe("Release check")
    expect(getGoalLabel("FUTURE_REVIEW")).toBe("Future review")
    expect(modeLabel("STANDARD")).toBe("Standard")
    expect(evidenceTypeLabel("LOG_SNIPPET")).toBe("Log output")
    expect(humanizeToken("PENDING_APPROVAL")).toBe("Pending approval")
  })
})
