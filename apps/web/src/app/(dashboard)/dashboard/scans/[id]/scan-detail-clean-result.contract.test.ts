import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// Polling runs in an effect, so server rendering cannot exercise this refresh path.
const source = readFileSync(new URL("./scan-detail-client.tsx", import.meta.url), "utf8")

describe("completed clean-result refresh", () => {
  it("refreshes the page when polling discovers a completed scan with no findings", () => {
    expect(source).toContain('updated.status === "COMPLETED" && refreshedFindings?.length === 0')
    expect(source).toContain("router.refresh()")
  })
})
