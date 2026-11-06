import {
  isConfirmedScanClaimRollback,
  ScanBillableClaimError,
} from "@lyrashield/db/src/scan-billable-claim"
import { enterEngineBillablePhase, resolveEngineRuntimeBudgetMs } from "./lifecycle-utils"
import { DelayedError, type Job } from "bullmq"
import {
  reserveScanCapacity,
  resetUnstartedScanCapacity,
  startUnmeteredScanCapacity,
  confirmScanCapacityStopped,
  ScanCapacityWaitingError,
  type ScanBillingDisposition,
} from "@lyrashield/billing"
import {
  requeueScanForRetry,
  releaseStoppedScanSlot,
  releaseUnstartedScanSlot,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import type { ScanJobData, ScanJobResult } from "../../types"
import type { ScanExecutionResult, executeScanTarget } from "./execution"
import type { ScanTerminalError } from "./settlement"

type ScanCapacityIdentity = {
  accountingVersion?: number | null
  workspaceId: string
  scanId: string
}
export async function prepareScanCapacity({
  accountingVersion,
  workspaceId,
  scanId,
  engineBacked,
  deterministicRetest,
  scanRuntimeBudgetMs,
}: ScanCapacityIdentity & {
  engineBacked: boolean
  deterministicRetest: boolean
  scanRuntimeBudgetMs: number
}) {
  if (accountingVersion === 2 && engineBacked && !deterministicRetest) {
    const capacity = await reserveScanCapacity({
      workspaceId,
      scanId,
      maxRuntimeMs: scanRuntimeBudgetMs,
    })
    if (capacity.state === "WAITING") throw new ScanCapacityWaitingError()
  }
  if (accountingVersion === 2 && (!engineBacked || deterministicRetest)) {
    await startUnmeteredScanCapacity(workspaceId, scanId)
  }
}

export async function finalizeScanCapacity({
  accountingVersion,
  workspaceId,
  scanId,
  recoveringPreviousExecution,
  billablePhaseStarted,
  executorReturned,
  noBillableWork,
  billingDisposition,
}: ScanCapacityIdentity & {
  recoveringPreviousExecution: boolean
  billablePhaseStarted: boolean
  executorReturned: boolean
  noBillableWork: boolean
  billingDisposition?: ScanBillingDisposition
}) {
  if (
    accountingVersion === 2 &&
    ((!recoveringPreviousExecution && !billablePhaseStarted) || executorReturned)
  ) {
    try {
      await confirmScanCapacityStopped(
        workspaceId,
        scanId,
        noBillableWork,
        billingDisposition,
        !billablePhaseStarted
      )
      await releaseStoppedScanSlot(workspaceId, scanId)
    } catch (accountingError) {
      logger.error("Scan admission remains held pending accounting review", {
        scanId,
        errorType: accountingError instanceof Error ? accountingError.name : "UNKNOWN",
      })
    }
  }
  if (recoveringPreviousExecution && !executorReturned && accountingVersion === 2) {
    // A prior executor may have committed stoppedAt before dying during
    // slot release. Only that durable proof permits this recovery.
    await releaseStoppedScanSlot(workspaceId, scanId).catch((error: unknown) => {
      logger.warn("Stopped scan slot recovery remains pending", {
        scanId,
        errorType: error instanceof Error ? error.name : "UNKNOWN",
      })
    })
  }
  if (accountingVersion === 2) {
    await releaseUnstartedScanSlot(workspaceId, scanId).catch((error: unknown) => {
      logger.warn("Unstarted scan slot remains held", {
        scanId,
        errorType: error instanceof Error ? error.name : "UNKNOWN",
      })
    })
  }
}

export async function deferScanCapacityWait(
  job: Job<ScanJobData, ScanJobResult>,
  workspaceId: string,
  scanId: string
): Promise<never> {
  await requeueScanForRetry({
    scanId,
    workspaceId,
    attempt: 1,
    maxAttempts: 1,
    clearStartedAt: true,
    errorCategory: "WAITING_CAPACITY",
    errorMessage: "Waiting for account review capacity",
  })
  // A capacity wait is not analysis time and does not consume an attempt.
  await job.moveToDelayed(Date.now() + 5_000, job.token)
  throw new DelayedError()
}

/** Returns true when a competing paid owner won before the guarded requeue. */
export async function requeueUnbilledScan(
  params: ScanCapacityIdentity & {
    job: Job<ScanJobData, ScanJobResult>
    maxAttempts: number
    recoveringPreviousExecution: boolean
    errorCategory: string
    errorMessage: string
  }
): Promise<boolean> {
  const { job, scanId, workspaceId, maxAttempts } = params
  try {
    const requeue = await requeueScanForRetry({
      scanId,
      workspaceId,
      attempt: (job.attemptsMade ?? 0) + 1,
      maxAttempts,
      errorCategory: params.errorCategory,
      errorMessage: params.errorMessage,
    })
    if (requeue.requeued && params.accountingVersion === 2 && !params.recoveringPreviousExecution) {
      await resetUnstartedScanCapacity(workspaceId, scanId)
    }
    if (!requeue.requeued) {
      logger.warn("Scan left an active status before retry requeue", {
        scanId,
        workspaceId,
        currentStatus: requeue.currentStatus,
      })
    }
    logger.warn("Scan job failed and will be retried", {
      scanId,
      workspaceId,
      attempt: (job.attemptsMade ?? 0) + 1,
      maxAttempts,
    })
    return false
  } catch (error) {
    if (error instanceof ScanBillableClaimError) return true
    throw error
  }
}

export function isCapacityStop(execution: Extract<ScanExecutionResult, { ok: true }>): boolean {
  const engineResult = execution.engineResult
  return (
    execution.capacityLimited === true &&
    ((engineResult.timedOut === true &&
      engineResult.timeoutReason !== "INACTIVITY" &&
      engineResult.timeoutReason !== "LLM_STALL") ||
      engineResult.output.runRecord?.terminal_reason === "runtime_deadline")
  )
}

export function capacityStopError(): ScanTerminalError {
  return {
    status: "STOPPED_BUDGET",
    errorCategory: "CAPACITY_EXHAUSTED",
    errorMessage:
      "Available review minutes reached. Partial evidence is preserved; unused reserved minutes are released.",
  }
}

export async function claimEngineCapacity(
  accountingVersion: number | null | undefined,
  workspaceId: string,
  scanId: string,
  engineTimeoutMs: number
) {
  if (accountingVersion !== 2) return { runtimeLimitMs: engineTimeoutMs, capacityLimited: false }
  const capacity = await reserveScanCapacity({
    workspaceId,
    scanId,
    maxRuntimeMs: engineTimeoutMs,
    start: true,
    claimBillable: true,
  }).catch((cause: unknown) => {
    if (isConfirmedScanClaimRollback(cause)) throw cause
    throw new ScanBillableClaimError(
      "Funded billable admission was refused or its commit is uncertain",
      { cause }
    )
  })
  if (capacity.state === "WAITING") throw new ScanCapacityWaitingError()
  if (capacity.state === "LEGACY") throw new Error("capacity_version_mismatch")
  return {
    capacityLimited: capacity.runtimeLimitMs < engineTimeoutMs,
    runtimeLimitMs: Math.min(engineTimeoutMs, capacity.runtimeLimitMs),
  }
}

export async function claimBoundedEngineCapacity(
  params: Pick<
    Parameters<typeof executeScanTarget>[0],
    | "accountingVersion"
    | "workspaceId"
    | "scanId"
    | "mode"
    | "target"
    | "scanRuntimeBudgetMs"
    | "elapsedScanMs"
    | "executionPlan"
    | "markGlobalScanTimeout"
    | "markBillablePhaseStarted"
  >
) {
  const { mode, target, scanRuntimeBudgetMs, elapsedScanMs, executionPlan, markGlobalScanTimeout } =
    params
  const engineTimeoutMs = Math.min(
    resolveEngineRuntimeBudgetMs(mode, target.type, scanRuntimeBudgetMs, elapsedScanMs()),
    // The engine can never exceed the recorded plan's budget.
    executionPlan ? executionPlan.limits.maxEngineMs : Number.POSITIVE_INFINITY
  )
  if (engineTimeoutMs <= 0) {
    markGlobalScanTimeout()
    throw new Error("Scan analysis deadline exhausted before engine execution")
  }

  const capacity = await claimEngineCapacity(
    params.accountingVersion,
    params.workspaceId,
    params.scanId,
    engineTimeoutMs
  )
  // Funded admission commits the lifetime claim in the reservation transaction.
  if (params.accountingVersion === 2) params.markBillablePhaseStarted()
  else await enterEngineBillablePhase(params.scanId, params.markBillablePhaseStarted)
  return capacity
}
