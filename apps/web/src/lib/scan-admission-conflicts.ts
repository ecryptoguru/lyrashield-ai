import { UserScanAlreadyActiveError, WorkspaceScanConcurrencyLimitError } from "@lyrashield/db"
import { MAX_CONCURRENT_WORKSPACE_SCANS } from "@lyrashield/types"
import { apiError } from "./api-response"
import type { ScanRefusalReason } from "./scan-refusal"

export function scanCreationConflict(
  error: unknown
): { reason: ScanRefusalReason; code: string; message: string; status: number } | null {
  if (error instanceof UserScanAlreadyActiveError)
    return { reason: "scan_in_progress", code: error.code, message: error.message, status: 409 }
  if (error instanceof WorkspaceScanConcurrencyLimitError)
    return {
      reason: "concurrency_limit",
      code: "SCAN_CONCURRENCY_LIMIT",
      status: 409,
      message: `This workspace already has ${MAX_CONCURRENT_WORKSPACE_SCANS} reviews running. Wait for one to finish before starting another.`,
    }
  return null
}

export function retestCreationError(
  error: unknown,
  confirmNotSubmitted: () => void
): Response | null {
  if (error instanceof UserScanAlreadyActiveError) {
    confirmNotSubmitted()
    return apiError(error.code, error.message, 409)
  }
  if (error instanceof WorkspaceScanConcurrencyLimitError)
    return apiError(
      "SCAN_CONCURRENCY_LIMIT",
      "This workspace is at its concurrent review limit. Wait for one to finish before retesting.",
      409
    )
  if (error instanceof Error && error.message === "Target already has an active scan")
    return apiError("RETEST_IN_PROGRESS", "A retest is already in progress for this target", 409)
  return null
}
