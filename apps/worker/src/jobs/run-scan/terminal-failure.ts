import { EvidenceStorageConfigurationError } from "../../engine/evidence-storage"
import { RetestBaselineUnavailableError } from "../../engine/deterministic-retest"
import { timeoutErrorMessage } from "./lifecycle-utils"

export interface ScanFailureClassification {
  finalErrorCategory: string
  finalErrorMessage: string
  isTerminalPrerequisiteFailure: boolean
}

/**
 * Classify a pre-settlement scan failure. A terminal prerequisite failure is an
 * expected, already-recorded refusal (or a configuration fault that retrying
 * cannot fix): it must not consume another queue attempt. The deterministic
 * retest refusal keeps its bounded reason so the scan reads as inconclusive
 * instead of an internal service failure.
 */
export function classifyScanFailure(
  error: unknown,
  options: { timedOut: boolean; scanRuntimeBudgetMs: number }
): ScanFailureClassification {
  if (options.timedOut) {
    return {
      finalErrorCategory: "TIMEOUT",
      finalErrorMessage: timeoutErrorMessage(options.scanRuntimeBudgetMs),
      isTerminalPrerequisiteFailure: false,
    }
  }
  if (error instanceof RetestBaselineUnavailableError) {
    return {
      finalErrorCategory: "RETEST_BASELINE_UNAVAILABLE",
      finalErrorMessage: error.reason,
      isTerminalPrerequisiteFailure: true,
    }
  }
  if (error instanceof EvidenceStorageConfigurationError) {
    return {
      finalErrorCategory: "EVIDENCE_STORAGE_CONFIGURATION",
      finalErrorMessage: "Evidence storage is not configured",
      isTerminalPrerequisiteFailure: true,
    }
  }
  return {
    finalErrorCategory: "INTERNAL_ERROR",
    finalErrorMessage: "The scan could not be completed because an internal service failed.",
    isTerminalPrerequisiteFailure: false,
  }
}
