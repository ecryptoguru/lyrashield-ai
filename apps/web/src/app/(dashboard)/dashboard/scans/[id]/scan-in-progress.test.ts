import { describe, expect, it } from "vitest"
import { buildScanAnnouncement } from "./scan-in-progress"

describe("scan progress announcements", () => {
  it("announces one concise stage and finding-count update", () => {
    expect(buildScanAnnouncement("Analyzing authentication", 1)).toBe(
      "Analyzing authentication. 1 finding detected so far."
    )
    expect(buildScanAnnouncement("Verifying evidence", 3)).toBe(
      "Verifying evidence. 3 findings detected so far."
    )
  })
})
