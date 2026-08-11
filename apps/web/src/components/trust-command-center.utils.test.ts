import { describe, expect, it } from "vitest"
import { commandCenterFirstMetric, dashboardPrimaryAction } from "./trust-command-center.utils"

describe("commandCenterFirstMetric", () => {
  it("guides an empty workspace to its next step instead of estimating a scan", () => {
    expect(commandCenterFirstMetric(0)).toBe("next-step")
    expect(commandCenterFirstMetric(1)).toBe("estimate")
  })
})

describe("dashboardPrimaryAction", () => {
  it("requires a target before offering a scan", () => {
    expect(dashboardPrimaryAction(0)).toEqual({
      href: "/dashboard/targets",
      label: "Add a target",
    })
    expect(dashboardPrimaryAction(1)).toEqual({
      href: "/dashboard/scans?new=1",
      label: "Start a scan",
    })
  })
})
