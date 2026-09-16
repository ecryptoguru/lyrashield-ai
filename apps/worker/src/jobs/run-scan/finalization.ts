import {
  addScanEvent,
  completeScanWithScore,
  prisma,
  updateScanStatus,
  withScanFinalizationClaim,
  type ScanStatus,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import type { resolveWorkerExecutionProvenance } from "@lyrashield/config"
import type { finalizationGrace } from "../../engine/scan-deadline"
import type { checkoutDeterministicRetest } from "../../engine/deterministic-retest"
import { persistFindings } from "../../engine/finding-persister"
import type { EngineRunResult } from "../../engine/runner"
import type { runScannerOrchestrator } from "../../engine/scanner-orchestrator"
import type { ScannerCoverageIssue } from "../../engine/scanner-coverage"
import { completeRetestsForScan, persistResultManifest } from "../../engine/result-integrity"
import type { ScanJobResult } from "../../types"
import type { ScanExecutionTarget } from "./preparation"
import type { ScanTerminalError } from "./settlement"
import { refreshGateVerdictAfterTerminalScan } from "./lifecycle-utils"

export type ScanFinalizationTerminalResult = {
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
  deterministicCheckout?: Awaited<ReturnType<typeof checkoutDeterministicRetest>>
  engineBacked: boolean
  budgetExceeded: boolean
  billedCostUsd: number | null
  costReconciled: boolean
  reconciliationReason?: string
  maxBudgetUsd: number
  workerExecution: ReturnType<typeof resolveWorkerExecutionProvenance>
  engineExecution?: Parameters<typeof persistResultManifest>[0]["engineExecution"]
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
    deterministicCheckout,
    engineBacked,
    budgetExceeded,
    billedCostUsd,
    costReconciled,
    reconciliationReason,
    maxBudgetUsd,
    workerExecution,
    engineExecution,
    meterEngineRun,
    onDurableResult,
  } = params

  return withScanFinalizationClaim(scanId, workspaceId, async () => {
    const persistedFindings = await persistFindings({
      scanId,
      workspaceId,
      targetId,
      vulnerabilities: orchestratorResult.allFindings,
      assertCanStart: grace.assertRemaining,
      // Stamp the scanned revision on every finding so fix patches apply
      // against exactly the commit that was analyzed.
      ...(engineResult.sourceRevision ? { sourceRevision: engineResult.sourceRevision } : {}),
    })

    const newFindings = persistedFindings.filter((f) => f.isNew).length
    grace.assertRemaining()
    const dupFindings = persistedFindings.length - newFindings

    // engineResult.output.summary describes only the agentic engine's own
    // vulnerabilities.json artifact (see parseEngineOutput). It never sees the
    // SCA, secrets, agent-config, or URL scanner findings that the
    // orchestrator merges in, nor the false-positive filtering and dedup that
    // happen afterward — so on a run where the engine layer alone found
    // nothing, it reads "0 finding(s) reported" next to a persisted finding
    // count that can be dozens. That text becomes scan.summary, which the
    // dashboard, the private assurance report, and completion notifications
    // all display verbatim, so the mismatch is user-facing, not just internal.
    // Leave the engine's own text untouched when it already matches what was
    // persisted; only correct it when the two disagree, so this stays a
    // targeted fix rather than a rewrite of copy that was already accurate.
    const scanSummary =
      persistedFindings.length !== engineResult.output.findingCount
        ? `${engineResult.output.summary} ${persistedFindings.length} finding(s) retained after all scanner layers and deduplication.`
        : engineResult.output.summary

    try {
      await addScanEvent(
        scanId,
        "findings_persisted",
        "info",
        `Persisted ${persistedFindings.length} finding(s): ${newFindings} new, ${dupFindings} duplicate`,
        {
          total: persistedFindings.length,
          new: newFindings,
          duplicate: dupFindings,
        }
      )
    } catch (eventErr) {
      logger.warn("Failed to persist findings_persisted event", {
        scanId,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      })
    }

    // Persist the result manifest for every outcome, including a failed or
    // incomplete engine, so coverage receipts are always available. The
    // manifest must exist BEFORE retest finalization: completeRetestsForScan
    // binds its verdict to the stored baseline/retest checksums, so a crash
    // between manifest and retests resumes finalization from the receipt
    // evidence instead of skipping it.
    await prisma.scan.update({
      where: { id: scanId },
      data: { summary: scanSummary },
    })
    const finishEvidence = async () => {
      const terminalError = params.terminalErrorAfterMeter()
      // Once sealing starts, await the whole evidence/retest/settlement
      // sequence. Interrupting between its writes could promote an
      // incomplete retest or abandon an unsettled billing transaction.
      grace.assertRemaining()
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
