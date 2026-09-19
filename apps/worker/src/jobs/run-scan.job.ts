import type { Job } from "bullmq"
import { boundedCleanup, finalizationGrace, scanElapsedClock } from "../engine/scan-deadline"
import { prisma, runWithWorkspaceContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { env, resolveWorkerExecutionProvenance } from "@lyrashield/config"
import type { checkoutDeterministicRetest } from "../engine/deterministic-retest"

import { summarizeVibeSecurityCoverage } from "@lyrashield/security"
import { executeScanTarget, resolveEngineTerminalError } from "./run-scan/execution"
import { createEngineMinuteMeter, type ScanTerminalError } from "./run-scan/settlement"
import { finalizeScanLifecycle } from "./run-scan/finalization"
import { runEngineTriageOverlay } from "./run-scan/triage"
import {
  updateScanStatus,
  addScanEvent,
  createAiSecurityScoreSnapshot,
  qualifyReferralForWorkspace,
  type ScanStatus,
} from "@lyrashield/db"
import { resolveScanProfile, type UrlScanProfile } from "@lyrashield/types"
import { prepareScanExecution } from "./run-scan/preparation"
import {
  cleanupEngineWorkspace,
  interpretExitCode,
  resolveEngineProfile,
  type EngineRunResult,
} from "../engine/runner"
import { engineWorkspacePath } from "../engine/workspace-path"
import type { TargetType } from "../engine/command-builder"
import { EvidenceStorageConfigurationError } from "../engine/evidence-storage"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import {
  completeRetestsForScan,
  failTerminalRetestsForScan,
  markRetestsRunning,
  persistResultManifest,
} from "../engine/result-integrity"
import { notifyScanCompleted, notifyScanFailed, notifyCriticalFinding } from "../notifications"
import { type ScanJobData, type ScanJobResult } from "../types"
import { verifyScanJobAuthority } from "./run-scan/authority"
import { verifyScanAdmission } from "./run-scan/admission"
import { resumePendingScanFinalization } from "./run-scan/pending-finalization"
import {
  imageDigest,
  isTimeoutError,
  MAX_SCAN_RUNTIME_MS,
  reportInterruptedSettlement,
  resolveEngineRuntimeBudgetMs,
  resolveScanRuntimeBudgetMs,
  resolveScannerPhaseTimeoutMs,
  timeoutErrorMessage,
} from "./run-scan/lifecycle-utils"
import {
  engineRoutingCoverageIssue,
  extractActualCostUsd,
  extractUsageSummary,
  persistEngineUsageCheckpoint,
  shouldRecordAgentMinutes,
} from "./run-scan/usage"

export {
  engineRoutingCoverageIssue,
  extractActualCostUsd,
  extractUsageSummary,
  persistEngineUsageCheckpoint,
  resolveEngineRuntimeBudgetMs,
  resolveScanRuntimeBudgetMs,
  resolveScannerPhaseTimeoutMs,
  shouldRecordAgentMinutes,
}

export async function processScanJob(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
  const log = logger
  const authority = await verifyScanJobAuthority(job)
  if (!authority.ok) return authority.result
  const { data, scanRecord, workspaceId, executionPlan } = authority
  const { scanId, targetId, goal, mode, policyId } = data
  const elapsedScanMs = scanElapsedClock(scanRecord.startedAt)

  // Wrap the entire job in workspace context so the Prisma client extension's
  // auto-scoping safety net is active for all DB queries. Without this, a
  // missed manual workspaceId filter could leak cross-tenant data.
  return runWithWorkspaceContext(workspaceId, async () => {
    // Exact product/image/engine identity for every result manifest. The
    // worker startup gate already fails closed before readiness; this second
    // call ensures each scan's manifests carry the identity even if a future
    // caller skips startup validation. Null outside production.
    const workerExecution = resolveWorkerExecutionProvenance()
    let globalScanTimeoutReached = false
    let scanRuntimeBudgetMs = MAX_SCAN_RUNTIME_MS
    let billablePhaseStarted = false
    let urlProfile: UrlScanProfile | undefined
    let engineProfile: ReturnType<typeof resolveEngineProfile> | undefined
    let engineModel: string | undefined
    let durableFinalizationResult: ScanJobResult | null = null
    let deterministicCheckout: Awaited<ReturnType<typeof checkoutDeterministicRetest>> | undefined
    try {
      const resumedFinalization = await resumePendingScanFinalization({
        scanId,
        workspaceId,
        targetId,
      })
      if (resumedFinalization) return resumedFinalization

      const preparation = await prepareScanExecution({
        scanId,
        targetId,
        goal,
        mode,
        executionPlan,
      })
      if (!preparation.ok) return preparation.result
      const { target } = preparation
      urlProfile = preparation.urlProfile

      // 3. Run the scan engine
      await updateScanStatus(scanId, "RUNNING" as ScanStatus)
      await markRetestsRunning(scanId)

      const policy = policyId
        ? await prisma.policy.findFirst({
            where: { id: policyId, workspaceId, deletedAt: null },
            select: {
              maxBudgetUsd: true,
              maxDurationMinutes: true,
              blockedPaths: true,
              allowedDomains: true,
              destructiveTestsAllowed: true,
            },
          })
        : null
      const policyMaxBudgetUsd = policy?.maxBudgetUsd?.toNumber()
      scanRuntimeBudgetMs = resolveScanRuntimeBudgetMs(
        mode,
        policy?.maxDurationMinutes,
        target.type
      )

      const hasGlobalScanTimeout = (): boolean => {
        if (elapsedScanMs() >= scanRuntimeBudgetMs) {
          globalScanTimeoutReached = true
          return true
        }
        return false
      }

      // Cancellation is polled frequently (the scanner orchestrator checks on a
      // ~1s interval), so memoize the CANCELLED lookup for a short window to
      // avoid a DB query every second per active scan. A cancel is still
      // detected within CANCEL_CACHE_MS; correctness only requires timely
      // detection, not instantaneous.
      const CANCEL_CACHE_MS = 2000
      let cancelCacheAt = 0
      let cancelCacheValue = false
      const isScanCancelled = async (force = false): Promise<boolean> => {
        const now = Date.now()
        if (!force && now - cancelCacheAt < CANCEL_CACHE_MS) return cancelCacheValue
        const current = await prisma.scan.findUnique({
          where: { id: scanId },
          select: { status: true },
        })
        cancelCacheValue = current?.status === "CANCELLED"
        cancelCacheAt = now
        return cancelCacheValue
      }

      const isCancelledOrTimedOut = async () => {
        if (target.type !== "REPO" && hasGlobalScanTimeout()) return true
        return isScanCancelled()
      }

      const failWithScanTimeout = async (timeoutMessage: string) => {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "TIMEOUT",
          errorMessage: timeoutMessage,
        })
        try {
          await notifyScanFailed(workspaceId, scanId, timeoutMessage)
        } catch (notificationError) {
          log.warn("Failed to send scan timeout notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
      }

      let engineResult: EngineRunResult
      let engineStartedAtMs: number | null = null
      let maxBudgetUsd = 0
      const deterministicRetest =
        target.type === "REPO" && scanRecord.determinismMode === "targeted_scanner"
      const isUrlTarget = target.type === "WEB_APP" || target.type === "API"
      const scanProfile = isUrlTarget ? resolveScanProfile({ targetType: target.type, mode }) : null
      // Engine-backed URL scans (STANDARD/DEEP) share the repository engine
      // path; SAFE stays deterministic-only.
      const urlEngineBacked = isUrlTarget && scanProfile?.usesAi === true
      const engineBacked = target.type === "REPO" || urlEngineBacked

      // The emphasis receipt documents user intent for EVERY tier — including
      // deterministic-only scans where it steers nothing but is still recorded.
      if (job.data.focus) {
        await addScanEvent(scanId, "scan_scope", "info", "Requested emphasis recorded", {
          emphasis: job.data.focus,
        })
      }

      const admission = await verifyScanAdmission({
        scanId,
        workspaceId,
        targetId,
        mode,
        engineBacked,
        deterministicRetest,
        scanRecord,
        executionPlan,
        targetType: target.type,
        destructiveTestsAllowed: policy?.destructiveTestsAllowed === true,
        // Plan-required admission is deployable independently of the additive
        // migration: OFF drains legacy null-plan rows on their original path;
        // ON requires every job to carry a stored, hash-verified plan.
        planRequired: env.LYRASHIELD_SCAN_PLAN_REQUIRED === "1",
      })
      if (!admission.ok) return admission.result

      const execution = await executeScanTarget({
        scanId,
        workspaceId,
        goal,
        mode,
        focus: job.data.focus,
        target,
        policy,
        policyMaxBudgetUsd,
        scanRuntimeBudgetMs,
        elapsedScanMs,
        isScanCancelled,
        markGlobalScanTimeout: () => {
          globalScanTimeoutReached = true
        },
        markBillablePhaseStarted: () => {
          billablePhaseStarted = true
        },
        deterministicRetest,
        engineBacked,
        urlEngineBacked,
        scanProfile,
        executionPlan,
      })
      if (!execution.ok) return execution.result
      engineResult = execution.engineResult
      deterministicCheckout = execution.deterministicCheckout
      engineProfile = execution.engineProfile
      engineModel = execution.engineModel
      maxBudgetUsd = execution.maxBudgetUsd
      engineStartedAtMs = execution.engineStartedAtMs
      const stagedAttachments = execution.stagedAttachments ?? null

      if (target.type !== "REPO" && globalScanTimeoutReached) {
        const timeoutMessage = timeoutErrorMessage(scanRuntimeBudgetMs)
        await failWithScanTimeout(timeoutMessage)
        return { status: "failed", errorCategory: "TIMEOUT", errorMessage: timeoutMessage }
      }

      if (isUrlTarget && !urlEngineBacked) {
        await addScanEvent(
          scanId,
          "engine_skipped",
          "info",
          "Deterministic-only tier — engine runs are part of STANDARD and DEEP reviews",
          { targetType: target.type }
        )
      }

      const runRecord = engineResult.output.runRecord
      const routingCoverageIssue =
        engineBacked && engineProfile ? engineRoutingCoverageIssue(engineProfile, runRecord) : null
      const exitInterpretation = interpretExitCode(engineResult.exitCode)
      const cancelled = engineResult.cancelled === true
      const engineWorkObserved =
        engineBacked &&
        shouldRecordAgentMinutes(scanId, exitInterpretation.status, runRecord, { cancelled })

      // ─── Sprint 10: Agent-minute metering (wall-clock) ──────────────────
      // Record wall-clock agent minutes only after a valid completed receipt
      // or affirmative provider usage proves that model-backed work occurred.
      // Per D1 constraint: minutes are wall-clock, NOT "active-loop" or "thinking time".
      // Deep/Custom scans consume 3× minutes (applied inside recordAgentMinutes).
      // Billing outcome (founder-confirmed 2026-08-29): failed scans are never
      // billed; cancelled scans bill elapsed time only (no 1-minute floor).
      const engineWallClockMs =
        engineStartedAtMs === null ? 0 : Math.max(1, Date.now() - engineStartedAtMs)
      let agentMinuteTerminalError: ScanTerminalError | null = null
      const meterEngineRun = createEngineMinuteMeter({
        scanId,
        workspaceId,
        mode,
        engineBacked,
        engineWallClockMs,
        sponsorAccountId: scanRecord.sponsorAccountId ?? scanRecord.createdById,
        exitStatus: exitInterpretation.status,
        runRecord,
        onTerminalError: (error) => {
          agentMinuteTerminalError = error
        },
      })

      // Persist usage before deterministic scanners or finding persistence can
      // fail, so provider spend is never lost behind a downstream error.
      let { budgetExceeded, billedCostUsd, costReconciled, reconciliationReason } =
        await persistEngineUsageCheckpoint({
          scanId,
          maxBudgetUsd,
          llmUsage: engineResult.output.runRecord?.llm_usage,
          webSearchCostUsd: engineResult.output.runRecord?.webSearchCostUsd,
          usageExpected: engineBacked && !deterministicRetest,
        })
      const engineExecution =
        engineWorkObserved && engineProfile && engineModel
          ? {
              // Spread-only-when-present (matching every other receipt field
              // below): a receipt that omits model/reasoning must not persist
              // empty strings into the manifest.
              ...(runRecord?.model ? { model: runRecord.model } : {}),
              ...(runRecord?.reasoning_effort
                ? { reasoningEffort: runRecord.reasoning_effort }
                : {}),
              image: env.LYRASHIELD_IMAGE || null,
              ...(imageDigest(env.LYRASHIELD_IMAGE)
                ? { imageDigest: imageDigest(env.LYRASHIELD_IMAGE) }
                : {}),
              ...(runRecord?.engine_version ? { engineVersion: runRecord.engine_version } : {}),
              ...(runRecord?.prompt_bundle_hash
                ? { promptBundleHash: runRecord.prompt_bundle_hash }
                : {}),
              ...(runRecord?.max_output_tokens
                ? { maxOutputTokens: runRecord.max_output_tokens }
                : {}),
              ...(runRecord?.max_agents ? { maxAgents: runRecord.max_agents } : {}),
              ...(runRecord?.delegate_model ? { delegateModel: runRecord.delegate_model } : {}),
              ...(runRecord?.delegate_reasoning_effort
                ? { delegateReasoningEffort: runRecord.delegate_reasoning_effort }
                : {}),
              ...(runRecord?.model_routing_policy
                ? { routingPolicy: runRecord.model_routing_policy }
                : {}),
              ...(runRecord?.compaction_trigger_tokens
                ? { compactionTriggerTokens: runRecord.compaction_trigger_tokens }
                : {}),
              ...(runRecord?.compaction_target_tokens
                ? { compactionTargetTokens: runRecord.compaction_target_tokens }
                : {}),
              ...(engineResult.sourceRevision
                ? { sourceRevision: engineResult.sourceRevision }
                : {}),
              ...(typeof engineResult.sandboxRemoved === "boolean"
                ? { sandboxRemoved: engineResult.sandboxRemoved }
                : runRecord?.cleanup
                  ? { sandboxRemoved: runRecord.cleanup.sandbox_removed }
                  : {}),
            }
          : undefined

      if (engineResult.cancelled) {
        await meterEngineRun("cancelled")
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }

      if (engineResult.budgetKilled) {
        const budgetMessage = "Protected run limit reached"
        await persistResultManifest({
          scanId,
          target: {
            id: target.id,
            type: target.type,
            repoFullName: target.repoFullName,
            branch: target.branch,
            url: target.url,
          },
          engineBacked,
          sourceCheckoutAvailable: Boolean(engineResult.sourceCheckoutPath),
          engineFindingCount: 0,
          coverageIssues: [{ scanner: "engine", status: "bounded", reason: budgetMessage }],
          engineExecution,
          accounting: {
            maxBudgetUsd,
            billedCostUsd,
            reconciled: costReconciled,
            ...(reconciliationReason ? { reconciliationReason } : {}),
          },
          workerExecution,
          ...(stagedAttachments ? { attachments: stagedAttachments } : {}),
          terminalOutcome: {
            status: "STOPPED_BUDGET",
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: budgetMessage,
          },
        })
        await completeRetestsForScan({ scanId, workspaceId })
        await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: budgetMessage,
          ...(billedCostUsd !== null ? { actualCostCents: Math.round(billedCostUsd * 100) } : {}),
        })
        try {
          await notifyScanFailed(workspaceId, scanId, budgetMessage)
        } catch (notificationError) {
          log.warn("Failed to send budget-stop notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
        return {
          status: "failed",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: budgetMessage,
        }
      }

      if (engineResult.timedOut) {
        const inactive = engineResult.timeoutReason === "INACTIVITY"
        const llmStalled = engineResult.timeoutReason === "LLM_STALL"
        const timeoutMessage = inactive
          ? "Scan engine stopped after no durable progress was observed"
          : llmStalled
            ? "Scan engine stalled: no model activity was observed while the run stayed active"
            : "Scan engine timed out before completing"
        await persistResultManifest({
          scanId,
          target: {
            id: target.id,
            type: target.type,
            repoFullName: target.repoFullName,
            branch: target.branch,
            url: target.url,
          },
          engineBacked,
          sourceCheckoutAvailable: Boolean(engineResult.sourceCheckoutPath),
          engineFindingCount: 0,
          coverageIssues: [{ scanner: "engine", status: "bounded", reason: timeoutMessage }],
          engineExecution,
          accounting: {
            maxBudgetUsd,
            billedCostUsd,
            reconciled: costReconciled,
            ...(reconciliationReason ? { reconciliationReason } : {}),
          },
          workerExecution,
          ...(stagedAttachments ? { attachments: stagedAttachments } : {}),
          terminalOutcome: {
            status: "FAILED",
            errorCategory: inactive || llmStalled ? "ENGINE_INACTIVE" : "TIMEOUT",
            errorMessage: timeoutMessage,
          },
        })
        await completeRetestsForScan({ scanId, workspaceId })
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: inactive || llmStalled ? "ENGINE_INACTIVE" : "TIMEOUT",
          errorMessage: timeoutMessage,
        })
        try {
          await notifyScanFailed(workspaceId, scanId, timeoutMessage)
        } catch (notificationError) {
          log.warn("Failed to send scan timeout notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
        return {
          status: "failed",
          errorCategory: inactive || llmStalled ? "ENGINE_INACTIVE" : "TIMEOUT",
          errorMessage: timeoutMessage,
        }
      }

      // Capture the engine's real terminal cause, but do not return early.
      // Deterministic scanners can still provide value from a partial engine run
      // (for example, when the engine cloned the repository but stopped for a
      // budget or model error). Usage is checkpointed above for reconciliation.
      let engineTerminalError = await resolveEngineTerminalError({
        scanId,
        engineBacked,
        deterministicRetest,
        engineResult,
        exitInterpretation,
        priorError: agentMinuteTerminalError,
      })

      // 4. Run scanner orchestrator (SCA + secrets + normalization)
      await updateScanStatus(scanId, "VERIFYING" as ScanStatus)
      const scannerPhaseTimeoutMs = resolveScannerPhaseTimeoutMs(
        scanRuntimeBudgetMs,
        elapsedScanMs()
      )

      const orchestratorResult = await runScannerOrchestrator({
        scanId,
        workspaceId,
        targetId,
        target: {
          id: target.id,
          type: target.type as TargetType,
          url: target.url,
          repoFullName: target.repoFullName,
          name: target.name,
          apiSpecUrl: target.apiSpecUrl,
        },
        goal,
        mode,
        engineFindings: engineResult.output.vulnerabilities,
        workspaceDir: engineResult.sourceCheckoutPath ?? undefined,
        scannerPhaseTimeoutMs,
        isCancelled: engineBacked ? isScanCancelled : isCancelledOrTimedOut,
        urlProfile,
      })

      const triageOverlay = await runEngineTriageOverlay({
        scanId,
        sponsorAccountId: scanRecord.sponsorAccountId ?? scanRecord.createdById,
        targetType: target.type,
        mode,
        deterministicRetest,
        agentMinuteTerminalError,
        hasGlobalScanTimeout,
        isScanCancelled,
        engineResult,
        aiSecuritySignals: orchestratorResult.aiAppSecuritySignals ?? [],
        billedCostUsd,
        costReconciled,
        budgetExceeded,
        reconciliationReason,
        maxBudgetUsd,
        scanRuntimeBudgetMs,
        elapsedScanMs,
      })
      const aiSecuritySignals = triageOverlay.aiSecuritySignals
      const triageSnapshot = triageOverlay.triageSnapshot
      budgetExceeded = triageOverlay.budgetExceeded
      billedCostUsd = triageOverlay.billedCostUsd
      costReconciled = triageOverlay.costReconciled
      reconciliationReason = triageOverlay.reconciliationReason

      try {
        await addScanEvent(
          scanId,
          "scanners_complete",
          "info",
          `Scan phases complete: engine=${orchestratorResult.engineFindings.length}, sca=${orchestratorResult.scaFindings.length}, secrets=${orchestratorResult.secretsFindings.length}, url=${orchestratorResult.urlFindings.length}, agent_config=${orchestratorResult.agentConfigFindings.length}, sast=${orchestratorResult.sastFindings.length}, false_positives_filtered=${orchestratorResult.filteredFalsePositives}`,
          {
            engine: orchestratorResult.engineFindings.length,
            sca: orchestratorResult.scaFindings.length,
            secrets: orchestratorResult.secretsFindings.length,
            url: orchestratorResult.urlFindings.length,
            agentConfig: orchestratorResult.agentConfigFindings.length,
            sast: orchestratorResult.sastFindings.length,
            falsePositivesFiltered: orchestratorResult.filteredFalsePositives,
            stats: orchestratorResult.stats,
          }
        )
      } catch (eventErr) {
        log.warn("Failed to persist scanners_complete event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      const coverage = summarizeVibeSecurityCoverage(orchestratorResult.allFindings)
      try {
        await addScanEvent(
          scanId,
          "coverage_contract",
          "info",
          `Vibe Security 50: ${coverage.reviewControlsRequested} code/URL review controls requested where applicable; ${coverage.matchedControlRanks.length} produced findings; ${coverage.evidenceControlsRequired} require deployment or human evidence`,
          coverage
        )
      } catch (eventErr) {
        log.warn("Failed to persist coverage_contract event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      const grace = finalizationGrace()
      const finalization = await finalizeScanLifecycle({
        scanId,
        workspaceId,
        targetId,
        target,
        grace,
        engineResult,
        orchestratorResult,
        coverageMatchedControlRanks: coverage.matchedControlRanks,
        routingCoverageIssue,
        deterministicCheckout,
        engineBacked,
        budgetExceeded,
        billedCostUsd,
        costReconciled,
        reconciliationReason,
        maxBudgetUsd,
        workerExecution,
        engineExecution,
        stagedAttachments,
        terminalErrorAfterMeter: () => agentMinuteTerminalError ?? engineTerminalError,
        meterEngineRun,
        onDurableResult: (result) => {
          durableFinalizationResult = result
        },
      })

      if (finalization.status === "cancelled") {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }
      const { persistedFindings, newFindings, scanSummary, terminalResult } = finalization.value
      if (grace.remaining() <= 0) {
        log.warn("Finalization grace exhausted; optional follow-up work skipped", { scanId })
        return terminalResult ?? { status: "completed", summary: scanSummary }
      }
      if (terminalResult) {
        if (terminalResult.errorCategory !== "BUDGET_EXCEEDED") {
          try {
            await notifyScanFailed(workspaceId, scanId, terminalResult.errorMessage)
          } catch (notificationError) {
            log.warn("Failed to send scan failure notification", {
              scanId,
              error:
                notificationError instanceof Error
                  ? notificationError.message
                  : String(notificationError),
            })
          }
        }
        return terminalResult
      }

      if (orchestratorResult.aiAppSecurityCoverage) {
        try {
          await createAiSecurityScoreSnapshot(scanId, workspaceId, {
            signals: aiSecuritySignals,
            coverage: orchestratorResult.aiAppSecurityCoverage,
            ai03: orchestratorResult.ai03Coverage ?? {
              resolutionStatus: "UNSUPPORTED",
              advisoryStatus: "UNAVAILABLE",
              fresh: false,
            },
            ...(triageSnapshot ? { triage: triageSnapshot } : {}),
          })
        } catch (aiScoreErr) {
          log.warn("Failed to create AI security score snapshot", {
            scanId,
            error: aiScoreErr instanceof Error ? aiScoreErr.message : String(aiScoreErr),
          })
        }
      }
      try {
        await qualifyReferralForWorkspace(workspaceId)
      } catch (referralError) {
        // Referral accounting is downstream of scan completion. An outage here
        // must not retry or reverse a scan that has already completed atomically.
        log.warn("Failed to qualify referral after scan completion", {
          scanId,
          error: referralError instanceof Error ? referralError.message : String(referralError),
        })
      }

      log.info("Scan job completed", {
        scanId,
        targetId,
        exitCode: engineResult.exitCode,
        findings: persistedFindings.length,
        newFindings,
      })

      try {
        const criticalFindings = persistedFindings.filter((f) => f.severity === "CRITICAL")
        const notifications = await Promise.allSettled([
          notifyScanCompleted(workspaceId, scanId, scanSummary, persistedFindings.length),
          ...criticalFindings.map((finding) =>
            notifyCriticalFinding(workspaceId, finding.id, finding.title, target.name)
          ),
        ])
        const failedNotifications = notifications.filter(
          (notification): notification is PromiseRejectedResult =>
            notification.status === "rejected"
        )
        if (failedNotifications.length > 0) {
          log.warn("Some scan completion notifications failed", {
            scanId,
            failures: failedNotifications.map((notification) =>
              notification.reason instanceof Error
                ? notification.reason.message
                : String(notification.reason)
            ),
          })
        }
      } catch (notificationError) {
        // A notification provider outage must not retry or reverse an already-completed scan.
        log.warn("Failed to send scan completion notification", {
          scanId,
          error:
            notificationError instanceof Error
              ? notificationError.message
              : String(notificationError),
        })
      }

      return {
        status: "completed",
        summary: scanSummary,
      }
    } catch (error) {
      const isTerminalPrerequisiteFailure = error instanceof EvidenceStorageConfigurationError
      const timedOut = globalScanTimeoutReached || isTimeoutError(error)
      const finalErrorCategory = timedOut
        ? "TIMEOUT"
        : isTerminalPrerequisiteFailure
          ? "EVIDENCE_STORAGE_CONFIGURATION"
          : "INTERNAL_ERROR"
      const finalErrorMessage = timedOut
        ? timeoutErrorMessage(scanRuntimeBudgetMs)
        : isTerminalPrerequisiteFailure
          ? "Evidence storage is not configured"
          : "The scan could not be completed because an internal service failed."

      log.error("Scan job failed", {
        scanId,
        errorType: error instanceof Error ? error.name : "UNKNOWN",
      })

      const currentScan = await prisma.scan
        .findUnique({
          where: { id: scanId },
          select: { status: true, summary: true, errorCategory: true, errorMessage: true },
        })
        .catch(() => null)
      if (durableFinalizationResult) {
        log.error("billing.scan_settlement_commit_uncertain", {
          scanId,
          workspaceId,
          terminalStatus: currentScan?.status ?? "UNKNOWN",
          accountingReviewRequired: true,
          automaticReplayAllowed: false,
          errorType: error instanceof Error ? error.name : "UNKNOWN",
        })
        return durableFinalizationResult
      }
      // Do not overwrite an unknown durable outcome during a DB outage.
      if (!currentScan) throw error
      if (currentScan?.status === "CANCELLED") {
        if (globalScanTimeoutReached) {
          return {
            status: "failed",
            errorCategory: "TIMEOUT",
            errorMessage: timeoutErrorMessage(scanRuntimeBudgetMs),
          }
        }
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }
      // A terminal result was durable before any monetary commit. Errors in
      // post-processing or an uncertain commit response must not turn a charged
      // COMPLETED/PARTIAL result into FAILED or replay the paid engine.
      if (currentScan?.status === "COMPLETED") {
        await reportInterruptedSettlement(workspaceId, scanId)
        return { status: "completed", summary: currentScan.summary ?? "Scan completed" }
      }
      if (currentScan?.status === "PARTIAL") {
        await reportInterruptedSettlement(workspaceId, scanId)
        return {
          status: "failed",
          errorCategory: currentScan.errorCategory ?? "PARTIAL",
          errorMessage: currentScan.errorMessage ?? "Partial findings preserved",
        }
      }

      const maxAttempts = job.opts?.attempts ?? 1
      if (
        !billablePhaseStarted &&
        !isTerminalPrerequisiteFailure &&
        (job.attemptsMade ?? 0) + 1 < maxAttempts
      ) {
        await prisma.scan.updateMany({
          where: {
            id: scanId,
            status: { in: ["PREFLIGHT", "RUNNING", "VERIFYING"] },
          },
          data: { status: "QUEUED" },
        })
        log.warn("Scan job failed and will be retried", {
          scanId,
          attempt: (job.attemptsMade ?? 0) + 1,
          maxAttempts,
        })
        throw error
      }

      try {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: finalErrorCategory,
          errorMessage: finalErrorMessage,
        })
      } catch (updateErr) {
        log.error("Failed to update scan status on error", {
          scanId,
          errorType: updateErr instanceof Error ? updateErr.name : "UNKNOWN",
        })
        // ponytail: let BullMQ retain the terminal infrastructure failure when the DB cannot.
        throw error
      }

      return {
        status: "failed",
        errorCategory: finalErrorCategory,
        errorMessage: finalErrorMessage,
      }
    } finally {
      try {
        await failTerminalRetestsForScan(scanId)
      } catch (retestError) {
        log.warn("Failed to finalize retest state", {
          scanId,
          error: retestError instanceof Error ? retestError.message : String(retestError),
        })
      }
      try {
        await boundedCleanup(
          (async () => {
            await deterministicCheckout?.cleanup()
            await cleanupEngineWorkspace(engineWorkspacePath(scanId), scanId)
          })()
        )
      } catch (cleanupError) {
        const error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        log.error("Engine workspace cleanup requires operator attention", { scanId, error })
        try {
          await addScanEvent(
            scanId,
            "cleanup_failed",
            "error",
            "Engine workspace cleanup requires operator attention",
            { error }
          )
        } catch (eventError) {
          log.error("Failed to persist cleanup failure event", {
            scanId,
            error: eventError instanceof Error ? eventError.message : String(eventError),
          })
        }
      }
    }
  }) // end runWithWorkspaceContext
}
