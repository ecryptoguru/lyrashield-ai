"use client"

import Link from "next/link"
import { Button } from "@lyrashield/ui"
import { safeApiErrorMessage } from "@/components/api-error-card"
import { isBillingRecoveryCode } from "./scans-client.utils"
import {
  clearPendingScanSubmission,
  type PendingScanSubmission,
  type ScanOperationStatus,
  type ScanSubmissionScope,
} from "@/lib/scan-submission"
import type { Dispatch, SetStateAction } from "react"

interface ScanStatusNoticesProps {
  showCreate: boolean
  error: string | null
  errorCode: string | null
  eligibilityBlocked: boolean
  eligibilityCode: string | null
  canManageBilling: boolean
  scanRecoveryUnavailable: boolean
  scanRecoveryError: string | null
  scanSubmissionScope: ScanSubmissionScope
  setScanRecoveryUnavailable: Dispatch<SetStateAction<boolean>>
  setScanRecoveryError: Dispatch<SetStateAction<string | null>>
  setForceNewAfterRecovery: Dispatch<SetStateAction<boolean>>
  setShowCreate: Dispatch<SetStateAction<boolean>>
  pendingScanSubmission: PendingScanSubmission | null
  principalId: string
  workspaceId: string
  pendingScanMatchesCurrent: boolean
  scanOperationStatus: ScanOperationStatus | null
  checkingScanOperation: boolean
  checkPendingScanOperation: (submission: PendingScanSubmission) => Promise<void>
  setPendingScanSubmission: Dispatch<SetStateAction<PendingScanSubmission | null>>
  setScanOperationStatus: Dispatch<SetStateAction<ScanOperationStatus | null>>
  pollStale: boolean
  handleRefresh: () => Promise<void>
  refreshing: boolean
}

export function ScanStatusNotices({
  showCreate,
  error,
  errorCode,
  eligibilityBlocked,
  eligibilityCode,
  canManageBilling,
  scanRecoveryUnavailable,
  scanRecoveryError,
  scanSubmissionScope,
  setScanRecoveryUnavailable,
  setScanRecoveryError,
  setForceNewAfterRecovery,
  setShowCreate,
  pendingScanSubmission,
  principalId,
  workspaceId,
  pendingScanMatchesCurrent,
  scanOperationStatus,
  checkingScanOperation,
  checkPendingScanOperation,
  setPendingScanSubmission,
  setScanOperationStatus,
  pollStale,
  handleRefresh,
  refreshing,
}: ScanStatusNoticesProps) {
  return (
    <>
      {error && !showCreate && (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/10 text-destructive mb-4 rounded-lg border p-3 text-sm"
        >
          <span>{safeApiErrorMessage(error)}</span>
          {(isBillingRecoveryCode(errorCode) ||
            (eligibilityBlocked && isBillingRecoveryCode(eligibilityCode))) && (
            <BillingRecoveryLink canManageBilling={canManageBilling} />
          )}
        </div>
      )}

      {scanRecoveryUnavailable && !showCreate && (
        <div
          role="alert"
          className="border-amber-500/50 bg-amber-500/10 mb-4 rounded-lg border p-3 text-sm"
        >
          <p>
            {scanRecoveryError ??
              "Saved scan recovery data could not be read. Starting again may create a second scan."}
          </p>
          <Button
            className="mt-2"
            type="button"
            variant="outline"
            onClick={() => {
              try {
                clearPendingScanSubmission(scanSubmissionScope)
                setScanRecoveryUnavailable(false)
                setScanRecoveryError(null)
                setForceNewAfterRecovery(true)
                setShowCreate(true)
              } catch (cause) {
                setScanRecoveryError(
                  cause instanceof Error ? cause.message : "Could not clear scan recovery data."
                )
              }
            }}
          >
            Discard recovery data and continue
          </Button>
        </div>
      )}

      {!showCreate &&
        pendingScanSubmission &&
        pendingScanSubmission.principalId === principalId &&
        pendingScanSubmission.workspaceId === workspaceId && (
          <div
            className="border-amber-500/50 bg-amber-500/10 mb-4 flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            role={pendingScanSubmission.state === "accepted" ? "status" : "alert"}
            aria-live="polite"
          >
            <div className="space-y-1">
              {pendingScanSubmission.state === "accepted" && pendingScanSubmission.scanId ? (
                <p>
                  Scan accepted.{" "}
                  <Link
                    className="text-primary underline underline-offset-4"
                    href={`/dashboard/scans/${encodeURIComponent(pendingScanSubmission.scanId)}`}
                  >
                    View scan
                  </Link>
                </p>
              ) : (
                <p>
                  {pendingScanMatchesCurrent
                    ? "A previous scan start is unresolved. Retrying the same details reuses its key."
                    : "A previous scan start is unresolved, and the current details differ. Restore the same request or explicitly start a new scan."}
                </p>
              )}
              {scanRecoveryError && <p>{scanRecoveryError}</p>}
              {scanOperationStatus?.recovery === "poll" && (
                <p>The scan operation is still processing.</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {pendingScanSubmission.state === "accepted" && pendingScanSubmission.scanId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    try {
                      clearPendingScanSubmission(
                        scanSubmissionScope,
                        pendingScanSubmission.idempotencyKey
                      )
                      setPendingScanSubmission(null)
                      setScanOperationStatus(null)
                      setForceNewAfterRecovery(false)
                      setShowCreate(true)
                    } catch (cause) {
                      setScanRecoveryUnavailable(true)
                      setScanRecoveryError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not clear scan recovery data."
                      )
                    }
                  }}
                >
                  Start another scan
                </Button>
              ) : (
                <>
                  {pendingScanSubmission.operationId && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={checkingScanOperation}
                      onClick={() => void checkPendingScanOperation(pendingScanSubmission)}
                    >
                      {checkingScanOperation ? "Checking status…" : "Check previous scan"}
                    </Button>
                  )}
                  {scanOperationStatus?.recovery !== "retry_new_key" && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setForceNewAfterRecovery(false)
                        setShowCreate(true)
                      }}
                    >
                      {pendingScanMatchesCurrent ? "Review same request" : "Review current request"}
                    </Button>
                  )}
                  {(!pendingScanMatchesCurrent ||
                    scanOperationStatus?.recovery === "retry_new_key") && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setForceNewAfterRecovery(true)
                        setShowCreate(true)
                      }}
                    >
                      Review details for a new scan
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

      {pollStale && (
        <div
          role="status"
          className="border-amber-500/50 bg-amber-500/10 mb-4 flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>Updates are paused. The displayed scan status may be stale.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing" : "Try again"}
          </Button>
        </div>
      )}
    </>
  )
}

function BillingRecoveryLink({ canManageBilling }: { canManageBilling: boolean }) {
  if (canManageBilling) {
    return (
      <Link href="/dashboard/billing" className="ml-2 underline underline-offset-4">
        Review billing options
      </Link>
    )
  }
  return (
    <span className="text-muted-foreground ml-2">
      Ask a workspace owner to review billing options.
    </span>
  )
}
