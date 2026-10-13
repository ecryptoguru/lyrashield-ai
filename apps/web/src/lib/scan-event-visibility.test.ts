import { describe, expect, it } from "vitest"
import { filterDashboardScanEvents } from "./scan-event-visibility"

describe("dashboard scan event visibility", () => {
  it("withholds the historical internal review and its expense metadata", () => {
    const visible = { stage: "engine_start", metadata: { model: "scanner" } }
    const internal = {
      stage: "terminal_cost_legacy_expense_reviewed",
      metadata: {
        conclusion: {
          providerCostUsd: "0.5676120000",
          originalEngineReportedCostUsd: "0.5676124550",
          roundingDifferenceUsd: "0.0000004550",
        },
      },
    }
    expect(filterDashboardScanEvents([visible, internal])).toEqual([visible])
  })
})
