import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  clearPendingScanSubmission,
  readPendingScanSubmission,
  runScanSubmission,
  type PendingScanSubmission,
  type ScanOperationStatus,
} from "@/lib/scan-submission"
import type { ManualScanOption } from "@/lib/scan-presets"
import type { OnboardingPath } from "./onboarding-flow.utils"
import type { OnboardingData, OnboardingFailureState } from "./onboarding-wizard-model"
import type { Repo } from "./onboarding-step-views"
import type { OnboardingPersist } from "./use-onboarding-persistence"
import type { OnboardingTrialStartState } from "./onboarding-scan-eligibility"
import {
  checkPendingScanOperation,
  createIdleScanEligibility,
  deriveOnboardingScanView,
  finishAcceptedOnboarding,
  runCreateTargetAndStart,
  type ScanFlowContext,
} from "./onboarding-scan-flow"

/**
 * Owns the scan-start flow: pending-submission recovery state, the advisory
 * eligibility gate, target create-or-recover, and the idempotent POST. The
 * wizard renders the surfaces; every transition here goes through the shared
 * scan-submission ledger in session storage.
 *
 * The flow machinery itself lives in ./onboarding-scan-flow so this hook stays
 * a thin binding of React state to it. Behaviour is unchanged.
 */
export function useOnboardingScan({
  principalId,
  data,
  path,
  selectedRepo,
  productName,
  urlForm,
  environment,
  selectedReview,
  completionPath,
  oauthReturnQuery,
  persist,
  // P1-1: the start action creates the workspace when the URL/API form did not.
  ensureWorkspace,
  setLoading,
  setError,
  setFailure,
  persistedTargetReusable,
  onTargetBound,
}: {
  principalId: string
  data: OnboardingData
  path: OnboardingPath
  selectedRepo: Repo | null
  productName: string
  urlForm: { url: string; ownershipAttested: boolean }
  environment: string
  selectedReview: ManualScanOption | undefined
  completionPath: string
  oauthReturnQuery: string | null | undefined
  persist: OnboardingPersist
  ensureWorkspace: () => Promise<string>
  setLoading: (loading: boolean) => void
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  // W2.3: the wizard computes whether the persisted targetId still describes
  // the visible source; the flow reuses it only when this is true.
  persistedTargetReusable: boolean
  onTargetBound: (needsRepo: boolean) => void
}) {
  const router = useRouter()
  const scanSubmissionLock = useRef(false)
  const [pendingScanSubmission, setPendingScanSubmission] = useState<PendingScanSubmission | null>(
    null
  )
  const [scanOperationStatus, setScanOperationStatus] = useState<ScanOperationStatus | null>(null)
  const [checkingScanOperation, setCheckingScanOperation] = useState(false)
  const [scanRecoveryError, setScanRecoveryError] = useState<string | null>(null)
  const [scanRecoveryUnavailable, setScanRecoveryUnavailable] = useState(false)
  const [scanEligibility, setScanEligibility] = useState(createIdleScanEligibility)
  const [checkedEligibilityKey, setCheckedEligibilityKey] = useState<string | null>(null)
  const startNewScanAfterPreflight = useRef(false)
  const targetRecovery = useRef<{ identity: string; targetId: string } | null>(null)
  const trialStart = useRef<OnboardingTrialStartState>({ confirmed: null, unknown: null })

  const ctx: ScanFlowContext = {
    principalId,
    data,
    path,
    selectedRepo,
    productName,
    urlForm,
    environment,
    selectedReview,
    completionPath,
    oauthReturnQuery,
    router,
    persist,
    ensureWorkspace,
    setLoading,
    setError,
    setFailure,
    scanSubmissionLock,
    startNewScanAfterPreflight,
    targetRecovery,
    trialStart,
    checkedEligibilityKey,
    setCheckedEligibilityKey,
    scanEligibility,
    setScanEligibility,
    setPendingScanSubmission,
    setScanOperationStatus,
    setCheckingScanOperation,
    setScanRecoveryError,
    setScanRecoveryUnavailable,
    persistedTargetReusable,
    onTargetBound,
  }

  useEffect(() => {
    // Browser session storage is external state and is only available after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScanOperationStatus(null)
    setScanRecoveryUnavailable(false)
    setScanRecoveryError(null)
    const workspaceId = data.workspaceId
    if (!workspaceId) {
      setPendingScanSubmission(null)
      return
    }
    try {
      const pending = readPendingScanSubmission({
        principalId,
        workspaceId,
        surface: "onboarding",
      })
      setPendingScanSubmission(pending)
    } catch (cause) {
      setPendingScanSubmission(null)
      setScanRecoveryUnavailable(true)
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Saved scan recovery data could not be read."
      )
    }
  }, [principalId, data.workspaceId])

  const { pendingScanMatchesCurrent, visibleEligibility } = deriveOnboardingScanView({
    principalId,
    data,
    selectedReview,
    pendingScanSubmission,
    checkedEligibilityKey,
    scanEligibility,
  })

  const createTargetAndStart = (
    startNewScan = false,
    skipEligibilityCheck = false,
    startTrial = false
  ) => runCreateTargetAndStart(ctx, startNewScan, skipEligibilityCheck, startTrial)

  const onStartAnotherAfterUnavailable = () => {
    if (!data.workspaceId) return
    try {
      clearPendingScanSubmission({
        principalId,
        workspaceId: data.workspaceId,
        surface: "onboarding",
      })
      setScanRecoveryUnavailable(false)
      setScanRecoveryError(null)
      void createTargetAndStart(true)
    } catch (cause) {
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Could not clear scan recovery data."
      )
    }
  }
  const onRetrySave = (scanId: string, goal: string) =>
    void runScanSubmission(scanSubmissionLock, () => finishAcceptedOnboarding(ctx, scanId, goal))
  const onCheckPending = (submission: PendingScanSubmission) =>
    void checkPendingScanOperation(ctx, submission)
  const onRetrySame = () => void createTargetAndStart()
  const onStartNew = () => void createTargetAndStart(true)

  return {
    pendingScanSubmission,
    pendingScanMatchesCurrent,
    scanOperationStatus,
    checkingScanOperation,
    scanRecoveryError,
    scanRecoveryUnavailable,
    visibleEligibility,
    createTargetAndStart,
    onStartAnotherAfterUnavailable,
    onRetrySave,
    onCheckPending,
    onRetrySame,
    onStartNew,
  }
}
