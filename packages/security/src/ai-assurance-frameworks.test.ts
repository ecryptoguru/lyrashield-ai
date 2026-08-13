import { describe, expect, it } from "vitest"
import {
  evaluateFrameworkReadiness,
  FRAMEWORK_MAPPING_VERSION,
  FRAMEWORK_MAPPINGS,
} from "./ai-assurance-frameworks"

describe("AI assurance framework mappings", () => {
  it("keeps incomplete evidence out of a satisfied readiness state", () => {
    const assessment = evaluateFrameworkReadiness({
      "AI-01": "NO_FINDING",
      "vibe-43": "EVIDENCE_REQUIRED",
    })

    expect(assessment.items).toContainEqual(
      expect.objectContaining({ controlId: "vibe-43", status: "NOT_ASSESSED" })
    )
  })

  it("pins each OWASP item to the mapping version and reports direct detections as observed", () => {
    const assessment = evaluateFrameworkReadiness({ "AI-01": "DETECTED" })

    expect(assessment.items).toContainEqual(
      expect.objectContaining({ controlId: "AI-01", status: "OBSERVED" })
    )
    expect(
      FRAMEWORK_MAPPINGS.every((item) => item.mappingVersion === FRAMEWORK_MAPPING_VERSION)
    ).toBe(true)
  })
})
