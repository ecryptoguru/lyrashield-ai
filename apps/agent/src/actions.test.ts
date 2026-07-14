import { describe, expect, it } from "vitest"
import { runScanAction } from "./actions"

describe("runScanAction", () => {
  it("requires approval for every high-impact scan mode", () => {
    expect(runScanAction.needsApproval?.({ mode: "SAFE" } as never)).toBe(false)
    expect(runScanAction.needsApproval?.({ mode: "STANDARD" } as never)).toBe(false)
    expect(runScanAction.needsApproval?.({ mode: "DEEP" } as never)).toBe(true)
    expect(runScanAction.needsApproval?.({ mode: "CUSTOM" } as never)).toBe(true)
  })
})
