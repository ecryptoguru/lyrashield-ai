import { ApiError } from "@/lib/api-client"
import {
  clearPendingScanSubmissionIfNotSubmitted,
  operationIdFromErrorDetails,
  recordScanOperation,
  type PendingScanSubmission,
  type ScanSubmissionScope,
} from "@/lib/scan-submission"

export function resolveScanSubmissionFailure({
  scope,
  submission,
  error,
}: {
  scope: ScanSubmissionScope
  submission: PendingScanSubmission
  error: unknown
}): {
  pendingSubmission: PendingScanSubmission | null
  recoveryError: string | null
  recoveryUnavailable: boolean
} {
  let notSubmitted = false
  let recoveryError: string | null = null
  if (error instanceof ApiError) {
    try {
      notSubmitted = clearPendingScanSubmissionIfNotSubmitted(
        scope,
        submission.idempotencyKey,
        error.details
      )
    } catch (cause) {
      recoveryError =
        cause instanceof Error ? cause.message : "Saved scan recovery data could not be cleared."
    }
  }

  let pendingSubmission: PendingScanSubmission | null = notSubmitted ? null : submission
  const operationId =
    error instanceof ApiError && !notSubmitted ? operationIdFromErrorDetails(error.details) : null
  if (operationId) {
    const updated = recordScanOperation(scope, submission.idempotencyKey, operationId)
    pendingSubmission = updated ?? { ...submission, operationId }
  }

  if (!notSubmitted || recoveryError) {
    recoveryError ??=
      error instanceof Error
        ? error.message
        : "We could not confirm whether the scan started. Retry with the same details."
  }
  return {
    pendingSubmission,
    recoveryError,
    recoveryUnavailable: notSubmitted && recoveryError !== null,
  }
}
