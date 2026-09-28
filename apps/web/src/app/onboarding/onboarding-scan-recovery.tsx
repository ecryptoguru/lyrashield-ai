"use client"

import Link from "next/link"
import { Button } from "@lyrashield/ui"
import type { PendingScanSubmission, ScanOperationStatus } from "@/lib/scan-submission"

interface OnboardingScanRecoveryProps {
  unavailable: boolean
  recoveryError: string | null
  workspaceId: string | null
  principalId: string
  pendingScanSubmission: PendingScanSubmission | null
  pendingScanMatchesCurrent: boolean
  scanOperationStatus: ScanOperationStatus | null
  completed: boolean
  selectedGoal: string | null
  selectedReviewGoal: string | undefined
  loading: boolean
  checkingScanOperation: boolean
  onStartAnotherAfterUnavailable: () => void
  onRetrySave: (scanId: string, goal: string) => void
  onCheckPending: (submission: PendingScanSubmission) => void
  onRetrySame: () => void
  onStartNew: () => void
}

export function OnboardingScanRecovery({
  unavailable,
  recoveryError,
  workspaceId,
  principalId,
  pendingScanSubmission,
  pendingScanMatchesCurrent,
  scanOperationStatus,
  completed,
  selectedGoal,
  selectedReviewGoal,
  loading,
  checkingScanOperation,
  onStartAnotherAfterUnavailable,
  onRetrySave,
  onCheckPending,
  onRetrySame,
  onStartNew,
}: OnboardingScanRecoveryProps) {
  return (
    <>
      {unavailable && (
        <div
          className="bg-warning/10 border-warning/50 mb-4 rounded-lg border p-3 text-sm"
          role="alert"
        >
          <p>
            {recoveryError ??
              "Saved scan recovery data could not be read. Starting again may create a second scan."}
          </p>
          {workspaceId && (
            <Button
              className="mt-2"
              type="button"
              variant="outline"
              disabled={loading}
              onClick={onStartAnotherAfterUnavailable}
            >
              Start another scan anyway
            </Button>
          )}
        </div>
      )}

      {pendingScanSubmission &&
        pendingScanSubmission.principalId === principalId &&
        pendingScanSubmission.workspaceId === workspaceId && (
          <div
            className="bg-muted/40 mb-4 flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            role={pendingScanSubmission.state === "accepted" ? "status" : "alert"}
            aria-live="polite"
          >
            <div className="space-y-1">
              {pendingScanSubmission.state === "accepted" && pendingScanSubmission.scanId ? (
                <>
                  <p className="font-medium">
                    {completed
                      ? "Your scan started."
                      : "Your scan started; onboarding could not be saved."}
                  </p>
                  <Link
                    className="text-primary underline underline-offset-4"
                    href={`/dashboard/scans/${encodeURIComponent(pendingScanSubmission.scanId)}`}
                  >
                    Open scan
                  </Link>
                </>
              ) : (
                <p>
                  A previous scan may still be starting. Retrying the same details reuses its key.
                </p>
              )}
              {pendingScanSubmission.state !== "accepted" && !pendingScanMatchesCurrent && (
                <p>
                  The current request has changed. Start a new scan explicitly to use these details.
                </p>
              )}
              {recoveryError && <p>{recoveryError}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {pendingScanSubmission.state === "accepted" && pendingScanSubmission.scanId ? (
                !completed && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading}
                    onClick={() =>
                      onRetrySave(
                        pendingScanSubmission.scanId!,
                        selectedGoal ?? selectedReviewGoal ?? "LAUNCH_REVIEW"
                      )
                    }
                  >
                    Retry saving onboarding
                  </Button>
                )
              ) : (
                <>
                  {pendingScanSubmission.operationId && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={checkingScanOperation}
                      onClick={() => onCheckPending(pendingScanSubmission)}
                    >
                      {checkingScanOperation ? "Checking status…" : "Check scan status"}
                    </Button>
                  )}
                  {pendingScanMatchesCurrent &&
                    scanOperationStatus?.recovery !== "retry_new_key" && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={loading}
                        onClick={onRetrySame}
                      >
                        Retry same details
                      </Button>
                    )}
                  {(!pendingScanMatchesCurrent ||
                    scanOperationStatus?.recovery === "retry_new_key") && (
                    <Button type="button" variant="outline" disabled={loading} onClick={onStartNew}>
                      Start a new scan anyway
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
    </>
  )
}
