import { apiGet } from "@/lib/api-client"
import {
  recordAcceptedScan,
  scanOperationStatusSchema,
  scanRequestIdentity,
  type PendingScanSubmission,
  type ScanOperationStatus,
  type ScanSubmissionScope,
} from "@/lib/scan-submission"
import type { ManualScanOption } from "@/lib/scan-presets"
import type { OnboardingData } from "./onboarding-wizard-model"
import type { OnboardingEligibilityState } from "./onboarding-step-views"

/**
 * The slice of the scan flow that pending-operation reconciliation reads and
 * writes. Narrow on purpose: the hook passes its own context object, which is a
 * superset, so nothing has to be copied at the call site.
 */
export type ScanOperationView = {
  principalId: string
  data: OnboardingData
  setScanOperationStatus: (status: ScanOperationStatus | null) => void
  setPendingScanSubmission: (submission: PendingScanSubmission | null) => void
  setCheckingScanOperation: (checking: boolean) => void
  setScanRecoveryError: (message: string | null) => void
  setScanRecoveryUnavailable: (unavailable: boolean) => void
}

/**
 * Reconcile a pending agent operation. `workspaceId` is passed in rather than
 * read from `view.data`, because the start action may have created the
 * workspace in this same call and the render's `data` is not updated yet
 * (P1-1).
 */
export async function checkPendingScanOperation(
  view: ScanOperationView,
  submission: PendingScanSubmission,
  workspaceId = view.data.workspaceId
) {
  if (!submission.operationId || !workspaceId) return
  const scope = {
    principalId: view.principalId,
    workspaceId,
    surface: "onboarding" as const,
  }
  view.setCheckingScanOperation(true)
  view.setScanRecoveryError(null)
  try {
    const status = await apiGet(
      `/api/agent-operations/${encodeURIComponent(submission.operationId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      { schema: scanOperationStatusSchema }
    )
    view.setScanOperationStatus(status)
    if (status.status === "COMPLETED" && status.resultLocation) {
      const accepted = {
        ...submission,
        state: "accepted" as const,
        scanId: status.resultLocation,
        operationId: status.operationId,
      }
      view.setPendingScanSubmission(accepted)
      try {
        recordAcceptedScan(
          scope,
          submission.idempotencyKey,
          status.resultLocation,
          status.operationId
        )
      } catch (cause) {
        view.setScanRecoveryUnavailable(true)
        view.setScanRecoveryError(
          cause instanceof Error
            ? cause.message
            : "Scan accepted; recovery details could not be saved."
        )
      }
    } else if (status.recovery === "retry_new_key") {
      view.setScanRecoveryError(
        "The previous attempt was not submitted. You can start a new attempt."
      )
    } else {
      view.setScanRecoveryError(
        "The previous scan start is still unresolved. Check its status again."
      )
    }
  } catch (cause) {
    view.setScanRecoveryError(
      cause instanceof Error ? cause.message : "Could not check the scan status."
    )
  } finally {
    view.setCheckingScanOperation(false)
  }
}

/**
 * Derive the two recovery surfaces the wizard renders from the persisted
 * submission and the eligibility snapshot. Pure: it reads no hook and writes no
 * state, so the rule is readable on its own and the render path does nothing
 * beyond this comparison.
 *
 * `pendingScanMatchesCurrent` decides whether the recovery panel offers to
 * resume the stored attempt. It is true only while the stored submission names
 * the same principal, the same workspace and the same request identity as the
 * source currently on screen — a different repo, URL or goal must never be
 * silently resumed.
 *
 * `visibleEligibility` is the advisory snapshot, shown only when it was read
 * for the exact target and goal now selected. Anything else reads as idle, so a
 * verdict from a previous target cannot be displayed as if it were this one's.
 */
export function deriveOnboardingScanRecovery({
  principalId,
  data,
  selectedReview,
  pendingScanSubmission,
  checkedEligibilityKey,
  scanEligibility,
}: {
  principalId: string
  data: OnboardingData
  selectedReview: ManualScanOption | undefined
  pendingScanSubmission: PendingScanSubmission | null
  checkedEligibilityKey: string | null
  scanEligibility: OnboardingEligibilityState
}): { pendingScanMatchesCurrent: boolean; visibleEligibility: OnboardingEligibilityState } {
  const scope: ScanSubmissionScope | null = data.workspaceId
    ? { principalId, workspaceId: data.workspaceId, surface: "onboarding" }
    : null
  const currentScanRequest =
    scope && data.targetId && selectedReview
      ? {
          workspaceId: data.workspaceId,
          targetId: data.targetId,
          goal: selectedReview.goal,
          mode: selectedReview.mode,
        }
      : null
  const pendingScanMatchesCurrent = Boolean(
    pendingScanSubmission &&
    pendingScanSubmission.principalId === principalId &&
    pendingScanSubmission.workspaceId === data.workspaceId &&
    currentScanRequest &&
    pendingScanSubmission.requestIdentity === scanRequestIdentity(currentScanRequest)
  )
  const selectedEligibilityKey =
    data.targetId && selectedReview
      ? JSON.stringify([data.targetId, selectedReview.goal, selectedReview.mode])
      : null
  const visibleEligibility =
    checkedEligibilityKey === selectedEligibilityKey ? scanEligibility : { status: "idle" as const }
  return { pendingScanMatchesCurrent, visibleEligibility }
}
