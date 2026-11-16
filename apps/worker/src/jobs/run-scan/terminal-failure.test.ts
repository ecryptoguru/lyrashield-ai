import { describe, expect, it } from "vitest"
import { EvidenceStorageConfigurationError } from "../../engine/evidence-storage"
import { RetestBaselineUnavailableError } from "../../engine/deterministic-retest"
import { classifyScanFailure } from "./terminal-failure"

const options = { timedOut: false, scanRuntimeBudgetMs: 60_000 }

describe("classifyScanFailure", () => {
  it("keeps a deterministic retest refusal terminal with its own bounded reason", () => {
    const failure = classifyScanFailure(new RetestBaselineUnavailableError(), options)

    expect(failure).toMatchObject({
      finalErrorCategory: "RETEST_BASELINE_UNAVAILABLE",
      isTerminalPrerequisiteFailure: true,
    })
    expect(failure.finalErrorMessage).toContain("complete deterministic baseline")
  })

  it("keeps evidence-storage configuration terminal", () => {
    expect(classifyScanFailure(new EvidenceStorageConfigurationError(), options)).toMatchObject({
      finalErrorCategory: "EVIDENCE_STORAGE_CONFIGURATION",
      isTerminalPrerequisiteFailure: true,
    })
  })

  it("leaves a timeout retryable with the budget message", () => {
    expect(classifyScanFailure(new Error("boom"), { ...options, timedOut: true })).toMatchObject({
      finalErrorCategory: "TIMEOUT",
      isTerminalPrerequisiteFailure: false,
    })
  })

  it("keeps unrelated errors as a generic internal failure", () => {
    expect(classifyScanFailure(new Error("boom"), options)).toMatchObject({
      finalErrorCategory: "INTERNAL_ERROR",
      isTerminalPrerequisiteFailure: false,
    })
  })
})
