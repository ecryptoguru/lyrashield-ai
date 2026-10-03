import { describe, expect, it } from "vitest"
import { scheduleTargetOptionLabel } from "./schedule-labels"

describe("scheduled scan target option labels", () => {
  it.each([
    [{ name: "Main repository", type: "REPO" }, "Main repository (Repository)"],
    [{ name: "Checkout site", type: "WEB_APP" }, "Checkout site (Web app)"],
    [{ name: "Checkout API", type: "API" }, "Checkout API (API)"],
  ])("uses a readable type label for %s", (target, expected) => {
    expect(scheduleTargetOptionLabel(target)).toBe(expected)
  })
})
