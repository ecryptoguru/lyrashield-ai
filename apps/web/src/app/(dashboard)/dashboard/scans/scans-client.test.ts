import { describe, expect, it } from "vitest"
import { mergePolledScans } from "./scans-client.utils"

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
