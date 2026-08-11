import { describe, expect, it } from "vitest"
import { getReviewSetupGuidance, mergePolledScans } from "./scans-client.utils"

describe("scan polling", () => {
  it("updates the first page while preserving older paginated scans", () => {
    const current = [
      { id: "new", status: "RUNNING" },
      { id: "old", status: "COMPLETED" },
    ]
    const refreshed = [
      { id: "latest", status: "QUEUED" },
      { id: "new", status: "COMPLETED" },
    ]

    expect(mergePolledScans(current, refreshed)).toEqual([
      { id: "latest", status: "QUEUED" },
      { id: "new", status: "COMPLETED" },
      { id: "old", status: "COMPLETED" },
    ])
  })
})

describe("review setup guidance", () => {
  it("gives an API target without a specification one direct unlock action", () => {
    expect(
      getReviewSetupGuidance({
        targetId: "target-1",
        targetType: "API",
        hasApiSpec: false,
      })
    ).toEqual({
      actionLabel: "Add OpenAPI document",
      href: "/dashboard/targets/target-1",
      message: "Add an OpenAPI document to unlock Contract and Contract Behavior reviews.",
    })
  })

  it("does not show setup guidance when every available review is already configured", () => {
    expect(
      getReviewSetupGuidance({
        targetId: "target-1",
        targetType: "API",
        hasApiSpec: true,
      })
    ).toBeNull()
  })
})
