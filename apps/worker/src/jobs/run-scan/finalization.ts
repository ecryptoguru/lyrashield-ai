import {
  addScanEvent,
  assertEvidenceEncrypted,
  completeScanWithScore,
  createAiSecurityScoreSnapshot,
  prisma,
  qualifyReferralForWorkspace,
  updateScanStatus,
  withScanFinalizationClaim,
  type ScanStatus,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import type { resolveWorkerExecutionProvenance } from "@lyrashield/config"
import type { finalizationGrace } from "../../engine/scan-deadline"
import type { checkoutDeterministicRetest } from "../../engine/deterministic-retest"
import { persistFindings } from "../../engine/finding-persister"
import { uploadScanArtifact } from "../../engine/evidence-storage"
import type { EngineRunResult } from "../../engine/runner"
import type { runScannerOrchestrator } from "../../engine/scanner-orchestrator"
import type { ScannerCoverageIssue } from "../../engine/scanner-coverage"
import { completeRetestsForScan, persistResultManifest } from "../../engine/result-integrity"
import type { ScanJobResult } from "../../types"
import type { ScanExecutionTarget } from "./preparation"
import type { ScanTerminalError } from "./settlement"
import type { EngineTriageSnapshot } from "./triage"
import { refreshGateVerdictAfterTerminalScan } from "./lifecycle-utils"
import { notifyCriticalFinding, notifyScanCompleted, notifyScanFailed } from "../../notifications"

type ScanFinalizationTerminalResult = {
  status: "failed"
  errorCategory: string
  errorMessage: string
}

export type ScanFinalizationValue = {
  persistedFindings: Awaited<ReturnType<typeof persistFindings>>
  newFindings: number
  scanSummary: string
  terminalResult: ScanFinalizationTerminalResult | null
}

type PersistedScanEvidence = {
  persistedFindings: Awaited<ReturnType<typeof persistFindings>>
  newFindings: number
  scanSummary: string
  ingestionWarnings: string[]
  threatModelRef: Parameters<typeof persistResultManifest>[0]["threatModel"]
  httpExchangeRef: Parameters<typeof persistResultManifest>[0]["httpExchangeEvidence"]
}

async function persistScanEvidence(params: {
  scanId: string
  workspaceId: string
  targetId: string
  engineResult: EngineRunResult
  orchestratorResult: Awaited<ReturnType<typeof runScannerOrchestrator>>
  assertCanStart: () => void
}): Promise<PersistedScanEvidence> {
  const { scanId, workspaceId, targetId, engineResult, orchestratorResult, assertCanStart } = params
  // Upload evidence before findings so each claim can bind the exact exchange
  // export it was validated against. Failed uploads remain explicit warnings.
  const ingestionWarnings = [...engineResult.output.ingestionIssues]
  const recordIngestionWarning = (message: string) => {
    if (ingestionWarnings.length < 100) ingestionWarnings.push(message.slice(0, 500))
  }
  let threatModelRef: PersistedScanEvidence["threatModelRef"] = null
  if (engineResult.output.threatModels) {
    try {
      assertCanStart()
      const uploaded = await uploadScanArtifact({
        workspaceId,
        scanId,
        type: "threat_model",
        artifactId: "threat-models",
        content: engineResult.output.threatModels.document,
        contentType: "application/json; charset=utf-8",
      })
      assertEvidenceEncrypted(uploaded.encryptionKeyRef)
      threatModelRef = {
        checksum: uploaded.checksum,
        byteLength: uploaded.byteLength,
        modelCount: engineResult.output.threatModels.models.length,
        ...(engineResult.output.threatModels.schemaVersion
          ? { schemaVersion: engineResult.output.threatModels.schemaVersion }
          : {}),
        // The encrypted artifact stays authoritative; keep the manifest preview small.
        entries: engineResult.output.threatModels.models.slice(0, 10).map((model) => ({
          target: model.target.slice(0, 120),
          preview: model.content.slice(0, 300),
        })),
      }
    } catch (error) {
      recordIngestionWarning(
        `threat model artifact could not be stored: ${error instanceof Error ? error.message : String(error)}`
      )
      logger.error("Failed to store threat-model evidence artifact", {
        scanId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  let httpExchangeRef: PersistedScanEvidence["httpExchangeRef"] = null
  if (engineResult.output.httpExchangeExport) {
    try {
      assertCanStart()
      const uploaded = await uploadScanArtifact({
        workspaceId,
        scanId,
        type: "http_exchanges",
        artifactId: "http-exchanges",
        content: engineResult.output.httpExchangeExport.document,
        contentType: "application/json; charset=utf-8",
      })
      assertEvidenceEncrypted(uploaded.encryptionKeyRef)
      httpExchangeRef = {
        checksum: uploaded.checksum,
        byteLength: uploaded.byteLength,
        exchangeCount: engineResult.output.httpExchangeExport.exchangeCount,
        ...(engineResult.output.httpExchangeExport.schemaVersion
          ? { schemaVersion: engineResult.output.httpExchangeExport.schemaVersion }
          : {}),
      }
    } catch (error) {
      // Validated exchange IDs without the stored export are warnings, not a durable receipt.
      recordIngestionWarning(
        `http exchange export artifact could not be stored: ${error instanceof Error ? error.message : String(error)}`
      )
      logger.error("Failed to store http-exchange evidence artifact", {
        scanId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const persistedFindings = await persistFindings({
    scanId,
    workspaceId,
    targetId,
    vulnerabilities: orchestratorResult.allFindings,
    assertCanStart,
    ...(engineResult.sourceRevision ? { sourceRevision: engineResult.sourceRevision } : {}),
    ...(httpExchangeRef?.checksum
      ? { httpExchangeArtifactChecksum: httpExchangeRef.checksum }
      : {}),
  })
  const newFindings = persistedFindings.filter((finding) => finding.isNew).length
  assertCanStart()
  const duplicateFindings = persistedFindings.length - newFindings
  const scanSummary =
    persistedFindings.length !== engineResult.output.findingCount
      ? `${engineResult.output.summary} ${persistedFindings.length} finding(s) retained after all scanner layers and deduplication.`
      : engineResult.output.summary

  await addScanEvent(
    scanId,
    "findings_persisted",
    "info",
    `Persisted ${persistedFindings.length} finding(s): ${newFindings} new, ${duplicateFindings} duplicate`,
    {
      total: persistedFindings.length,
      new: newFindings,
      duplicate: duplicateFindings,
    }
  ).catch((eventError) =>
    logger.warn("Failed to persist findings_persisted event", {
      scanId,
      error: eventError instanceof Error ? eventError.message : String(eventError),
    })
  )

  if (ingestionWarnings.length > 0) {
    await addScanEvent(
      scanId,
      "engine_evidence",
      "warning",
      `Engine evidence ingestion recorded ${ingestionWarnings.length} issue(s)`,
      { issues: ingestionWarnings.slice(0, 50) }
    ).catch((eventError) =>
      logger.warn("Failed to persist engine_evidence warning event", {
        scanId,
        error: eventError instanceof Error ? eventError.message : String(eventError),
      })
    )
  }

  await prisma.scan.update({ where: { id: scanId }, data: { summary: scanSummary } })
  return {
    persistedFindings,
    newFindings,
    scanSummary,
    ingestionWarnings,
    threatModelRef,
    httpExchangeRef,
  }
}

export async function finalizeEarlyEngineTerminal(params: {
  scanId: string
  workspaceId: string
  target: ScanExecutionTarget
  engineBacked: boolean
  engineResult: EngineRunResult
  workerExecution: ReturnType<typeof resolveWorkerExecutionProvenance>
  engineExecution?: Parameters<typeof persistResultManifest>[0]["engineExecution"]
  stagedAttachments?: Parameters<typeof persistResultManifest>[0]["attachments"]
  maxBudgetUsd: number
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
  terminalOutcome: {
    status: "FAILED" | "STOPPED_BUDGET"
    errorCategory: string
    errorMessage: string
  }
  actualCostCents?: number
  notificationDescription: "budget-stop" | "scan timeout"
}): Promise<ScanJobResult> {
  const {
    scanId,
    workspaceId,
    target,
    engineBacked,
    engineResult,
    workerExecution,
    engineExecution,
    stagedAttachments,
    maxBudgetUsd,
    billedCostUsd,
    costReconciled,
    reconciliationReason,
    terminalOutcome,
    actualCostCents,
    notificationDescription,
  } = params
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
    coverageIssues: [
      { scanner: "engine", status: "bounded", reason: terminalOutcome.errorMessage },
    ],
    engineExecution,
    accounting: {
      maxBudgetUsd,
      billedCostUsd,
      reconciled: costReconciled,
      ...(reconciliationReason ? { reconciliationReason } : {}),
    },
    workerExecution,
    ...(stagedAttachments ? { attachments: stagedAttachments } : {}),
    terminalOutcome,
  })
  await completeRetestsForScan({ scanId, workspaceId })
  await updateScanStatus(scanId, terminalOutcome.status as ScanStatus, {
    errorCategory: terminalOutcome.errorCategory,
    errorMessage: terminalOutcome.errorMessage,
    ...(actualCostCents !== undefined ? { actualCostCents } : {}),
  })
  try {
    await notifyScanFailed(workspaceId, scanId, terminalOutcome.errorMessage)
  } catch (notificationError) {
    logger.warn(`Failed to send ${notificationDescription} notification`, {
      scanId,
      error:
        notificationError instanceof Error ? notificationError.message : String(notificationError),
    })
  }
  return {
    status: "failed",
    errorCategory: terminalOutcome.errorCategory,
    errorMessage: terminalOutcome.errorMessage,
  }
}

export async function runScanCompletionFollowups(params: {
  scanId: string
  workspaceId: string
  targetId: string
  targetName: string
  exitCode: number
  scanSummary: string
  newFindings: number
  persistedFindings: ScanFinalizationValue["persistedFindings"]
  orchestratorResult: Awaited<ReturnType<typeof runScannerOrchestrator>>
  aiSecuritySignals: Parameters<typeof createAiSecurityScoreSnapshot>[2]["signals"]
  triageSnapshot?: EngineTriageSnapshot
}): Promise<void> {
  const {
    scanId,
    workspaceId,
    targetId,
    targetName,
    exitCode,
    scanSummary,
    newFindings,
    persistedFindings,
    orchestratorResult,
    aiSecuritySignals,
    triageSnapshot,
  } = params
  // These actions follow durable completion. Their failures must not replay or reverse the scan.
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
    } catch (aiScoreError) {
      logger.warn("Failed to create AI security score snapshot", {
        scanId,
        error: aiScoreError instanceof Error ? aiScoreError.message : String(aiScoreError),
      })
    }
  }
  try {
    await qualifyReferralForWorkspace(workspaceId)
  } catch (referralError) {
    logger.warn("Failed to qualify referral after scan completion", {
      scanId,
      error: referralError instanceof Error ? referralError.message : String(referralError),
    })
  }

  logger.info("Scan job completed", {
    scanId,
    targetId,
    exitCode,
    findings: persistedFindings.length,
    newFindings,
  })

  try {
    const criticalFindings = persistedFindings.filter((finding) => finding.severity === "CRITICAL")
    let workspaceName: string | undefined
    try {
      workspaceName = (
        await prisma.workspace.findFirst({
          where: { id: workspaceId },
          select: { name: true },
        })
      )?.name
    } catch (workspaceError) {
      logger.warn("Failed to resolve workspace name for scan completion notifications", {
        scanId,
        error: workspaceError instanceof Error ? workspaceError.message : String(workspaceError),
      })
    }

    const tasks = [
      () =>
        notifyScanCompleted(
          workspaceId,
          scanId,
          scanSummary,
          persistedFindings.length,
          workspaceName
        ),
      ...criticalFindings.map(
        (finding) => () =>
          notifyCriticalFinding(workspaceId, finding.id, finding.title, targetName, workspaceName)
      ),
    ]
    const notifications: PromiseSettledResult<void>[] = []
    for (let start = 0; start < tasks.length; start += 2) {
      notifications.push(
        ...(await Promise.allSettled(tasks.slice(start, start + 2).map((notify) => notify())))
      )
    }
    const failedNotifications = notifications.filter(
      (notification): notification is PromiseRejectedResult => notification.status === "rejected"
    )
    if (failedNotifications.length > 0) {
      logger.warn("Some scan completion notifications failed", {
        scanId,
        failures: failedNotifications.map((notification) =>
          notification.reason instanceof Error
            ? notification.reason.message
            : String(notification.reason)
        ),
      })
    }
  } catch (notificationError) {
    logger.warn("Failed to send scan completion notification", {
      scanId,
      error:
        notificationError instanceof Error ? notificationError.message : String(notificationError),
    })
  }
}

export async function finalizeScanLifecycle(params: {
  scanId: string
  workspaceId: string
  targetId: string
  target: ScanExecutionTarget
  grace: ReturnType<typeof finalizationGrace>
  engineResult: EngineRunResult
  orchestratorResult: Awaited<ReturnType<typeof runScannerOrchestrator>>
  coverageMatchedControlRanks: number[]
  routingCoverageIssue: ScannerCoverageIssue | null
  runtimeDeadlineCoverageIssue?: ScannerCoverageIssue | null
  deterministicCheckout?: Awaited<ReturnType<typeof checkoutDeterministicRetest>>
  engineBacked: boolean
  budgetExceeded: boolean
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
  maxBudgetUsd: number
  workerExecution: ReturnType<typeof resolveWorkerExecutionProvenance>
  engineExecution?: Parameters<typeof persistResultManifest>[0]["engineExecution"]
  /** Checksum-verified attachment staging receipt (null when none staged). */
  stagedAttachments?: Parameters<typeof persistResultManifest>[0]["attachments"]
  terminalErrorAfterMeter: () => ScanTerminalError | null
  meterEngineRun: (
    outcome: "completed" | "partial" | "failed" | "cancelled",
    finishEvidence?: () => Promise<void>
  ) => Promise<void>
  onDurableResult: (result: ScanJobResult) => void
}): Promise<{ status: "cancelled" } | { status: "finalized"; value: ScanFinalizationValue }> {
  const {
    scanId,
    workspaceId,
    targetId,
    target,
    grace,
    engineResult,
    orchestratorResult,
    coverageMatchedControlRanks,
    routingCoverageIssue,
    runtimeDeadlineCoverageIssue,
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
    meterEngineRun,
    onDurableResult,
  } = params

  return withScanFinalizationClaim(scanId, workspaceId, async () => {
    const evidence = await persistScanEvidence({
      scanId,
      workspaceId,
      targetId,
      engineResult,
      orchestratorResult,
      assertCanStart: grace.assertRemaining,
    })
    const {
      persistedFindings,
      newFindings,
      scanSummary,
      ingestionWarnings,
      threatModelRef,
      httpExchangeRef,
    } = evidence

    const finishEvidence = async () => {
      const terminalError = params.terminalErrorAfterMeter()
      // Once sealing starts, await the whole evidence/retest/settlement
      // sequence. Interrupting between its writes could promote an
      // incomplete retest or abandon an unsettled billing transaction.
      grace.assertRemaining()
      // Persist the manifest before retest completion so crash recovery binds
      // every verdict to stored baseline and retest receipts.
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
        engineFindingCount: orchestratorResult.engineFindings.length,
        coverageIssues: [
          ...orchestratorResult.coverageIssues,
          ...(routingCoverageIssue ? [routingCoverageIssue] : []),
          ...(runtimeDeadlineCoverageIssue ? [runtimeDeadlineCoverageIssue] : []),
        ],
        aiAppSecurityDiscovery: orchestratorResult.aiAppSecurityDiscovery,
        webMcpCoverage: orchestratorResult.webMcpCoverage,
        scannerDiscovery: orchestratorResult.scannerDiscovery,
        matchedControlRanks: coverageMatchedControlRanks,
        urlExecution: orchestratorResult.urlExecution,
        engineExecution,
        ...(deterministicCheckout
          ? {
              sourceExecution: {
                kind: "deterministic_retest" as const,
                sourceRevision: deterministicCheckout.sourceRevision,
              },
            }
          : {}),
        accounting: {
          maxBudgetUsd,
          billedCostUsd,
          reconciled: costReconciled,
          ...(reconciliationReason ? { reconciliationReason } : {}),
        },
        workerExecution,
        scopedCoverage: engineResult.output.scopedCoverage,
        threatModel: threatModelRef,
        httpExchangeEvidence: httpExchangeRef,
        ...(stagedAttachments ? { attachments: stagedAttachments } : {}),
        ...(ingestionWarnings.length > 0 ? { ingestionWarnings } : {}),
        terminalOutcome: terminalError
          ? {
              status: terminalError.status as "PARTIAL" | "FAILED" | "STOPPED_BUDGET",
              errorCategory: terminalError.errorCategory,
              errorMessage: terminalError.errorMessage,
            }
          : budgetExceeded
            ? {
                status: "STOPPED_BUDGET",
                errorCategory: "BUDGET_EXCEEDED",
                errorMessage: "Protected run limit reached",
              }
            : { status: "COMPLETED", errorCategory: null, errorMessage: null },
      })

      await completeRetestsForScan({ scanId, workspaceId })

      if (terminalError) {
        await updateScanStatus(scanId, terminalError.status, {
          errorCategory: terminalError.errorCategory,
          errorMessage: terminalError.errorMessage,
          ...(billedCostUsd !== null ? { actualCostCents: Math.round(billedCostUsd * 100) } : {}),
        })
        // A PARTIAL/FAILED/STOPPED terminal state still changed stored
        // evidence (findings, receipts) — refresh the gate verdict so it
        // never presents a stale pre-scan picture as current.
        await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
        return {
          persistedFindings,
          newFindings,
          scanSummary,
          terminalResult: {
            status: "failed" as const,
            errorCategory: terminalError.errorCategory,
            errorMessage: terminalError.errorMessage,
          },
        }
      }

      if (budgetExceeded) {
        await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
          actualCostCents: Math.round(billedCostUsd! * 100),
        })
        await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
        return {
          persistedFindings,
          newFindings,
          scanSummary,
          terminalResult: {
            status: "failed" as const,
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: "Protected run limit reached",
          },
        }
      }
      // Retests may validate a pending fix and change the target's scoreable
      // state. Freeze the score only after those outcomes are persisted.
      await completeScanWithScore(scanId, workspaceId, scanSummary)
      // Refresh the gate verdict now that this scan's evidence is stored.
      await refreshGateVerdictAfterTerminalScan(workspaceId, targetId, scanId)
      return { persistedFindings, newFindings, scanSummary, terminalResult: null }
    }
    let finished: ScanFinalizationValue | undefined
    // Quota refusal happens before any terminal evidence is sealed. For
    // billable results, DB-only finalization must finish before money commits.
    const initialTerminalError = params.terminalErrorAfterMeter()
    await meterEngineRun(
      budgetExceeded || initialTerminalError?.status === "STOPPED_BUDGET"
        ? "failed"
        : initialTerminalError?.status === "PARTIAL"
          ? "partial"
          : initialTerminalError
            ? "failed"
            : "completed",
      async () => {
        finished = await finishEvidence()
        onDurableResult(
          finished.terminalResult ?? {
            status: "completed",
            summary: finished.scanSummary,
          }
        )
      }
    )
    return finished ?? (await finishEvidence())
  })
}
