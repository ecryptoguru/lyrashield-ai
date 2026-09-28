import { describe, expect, it } from "vitest"
import { SEVERITY_COLOR, SEVERITY_ICON, SEVERITY_ORDER } from "./severity-presentation"

describe("severity presentation", () => {
  it("keeps sorted severities aligned with icon and colour coverage", () => {
    const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
    expect(severities.map((severity) => SEVERITY_ORDER[severity])).toEqual([0, 1, 2, 3, 4])
    for (const severity of severities) {
      expect(SEVERITY_ICON[severity]).toBeDefined()
      expect(SEVERITY_COLOR[severity]).toBeTruthy()
    }
  })
})
