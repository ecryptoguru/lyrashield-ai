import { describe, expect, it } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { publicScanToolResult } from "./scan-tool-provenance"
import { publicScanProvenance } from "./scan-provenance"
const executionPlan = buildScanExecutionPlan({ targetType: "REPO", mode: "STANDARD" })
describe("historical hosted scan receipts", () => {
  it.each([false, true])(
    "redacts nested structured and JSON text plans including errors=%s",
    (isError) => {
      const payload = {
        action: "scan_triggered",
        scan: { id: "scan", executionPlan, executionPlanHash: "private-digest" },
      }
      const original = {
        isError,
        structuredContent: payload,
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      }
      const result = publicScanToolResult(original)
      const expected = { ...payload, scan: { id: "scan", ...publicScanProvenance(executionPlan) } }
      expect(result.structuredContent).toEqual(expected)
      expect(JSON.parse(result.content[0]!.text)).toEqual(expected)
      expect(result.isError).toBe(isError)
      expect(original.structuredContent.scan.executionPlan).toHaveProperty("limits.maxBudgetUsd")
    }
  )
  it("keeps plain text and non-scan payloads unchanged", () => {
    const result = {
      structuredContent: { scanId: "scan" },
      content: [{ type: "text" as const, text: "plain text" }],
    }
    expect(publicScanToolResult(result)).toEqual(result)
  })
})
