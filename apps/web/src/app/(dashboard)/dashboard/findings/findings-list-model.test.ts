import { describe, expect, it } from "vitest"
import { sortFindings, updateFindingStatus, type FindingListItem } from "./findings-list-model"

function finding(
  id: string,
  severity: FindingListItem["severity"],
  score: number,
  lastSeenAt: string
): FindingListItem {
  return {
    id,
    title: id,
    summary: id,
    severity,
    status: "OPEN",
    verified: false,
    verificationStatus: "DETECTED",
    confidence: "MEDIUM",
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    priority: { score, band: "normal", reasons: [], limitations: [] },
  }
}

describe("findings list model", () => {
  const rows = [
    finding("low-priority", "LOW", 80, "2026-09-01T00:00:00.000Z"),
    finding("newest", "HIGH", 50, "2026-09-03T00:00:00.000Z"),
    finding("most-severe", "CRITICAL", 10, "2026-09-02T00:00:00.000Z"),
  ]

  it("sorts only loaded rows by the selected mode without mutating them", () => {
    expect(sortFindings(rows, "priority").map((row) => row.id)).toEqual([
      "low-priority",
      "newest",
      "most-severe",
    ])
    expect(sortFindings(rows, "severity").map((row) => row.id)).toEqual([
      "most-severe",
      "newest",
      "low-priority",
    ])
    expect(sortFindings(rows, "newest").map((row) => row.id)).toEqual([
      "newest",
      "most-severe",
      "low-priority",
    ])
    expect(rows.map((row) => row.id)).toEqual(["low-priority", "newest", "most-severe"])
  })

  it("updates and reprioritizes only the changed finding", () => {
    expect(updateFindingStatus(rows[0]!, "other", "FIXED")).toBe(rows[0])
    const updated = updateFindingStatus(rows[0]!, rows[0]!.id, "FIXED")
    expect(updated.status).toBe("FIXED")
    expect(updated.priority).toBeDefined()
    expect(rows[0]!.status).toBe("OPEN")
  })
})
