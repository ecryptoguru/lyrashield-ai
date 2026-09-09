import { describe, expect, it } from "vitest"
import { commandCenterFirstMetric } from "./trust-command-center.utils"

describe("commandCenterFirstMetric", () => {
  it("guides an empty workspace to its next step instead of estimating a scan", () => {
    expect(commandCenterFirstMetric(0)).toBe("next-step")
    expect(commandCenterFirstMetric(1)).toBe("estimate")
  })
})
