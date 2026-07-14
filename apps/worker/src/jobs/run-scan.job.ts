import type { Job } from "bullmq"
import { prisma, runWithWorkspaceContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { buildVibeSecurityInstruction, summarizeVibeSecurityCoverage } from "@lyrashield/security"
import {
  updateScanStatus,
  addScanEvent,
  completeScanWithScore,
  qualifyReferralForWorkspace,
  type ScanStatus,
} from "@lyrashield/db"
import { runPreflight } from "./preflight.job"
import {
  runEngine,
  cleanupEngineWorkspace,
  interpretExitCode,
  type EngineRunResult,
} from "../engine/runner"
import { resolveScanBudgetUsd, type TargetType } from "../engine/command-builder"
import { persistFindings } from "../engine/finding-persister"
import { EvidenceStorageConfigurationError } from "../engine/evidence-storage"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import { notifyScanCompleted, notifyScanFailed, notifyCriticalFinding } from "../notifications"
import type { ScanJobData, ScanJobResult } from "../types"

export function extractActualCostUsd(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null
  for (const key of ["total_cost_usd", "cost_usd", "total_cost", "cost"]) {
    const value = usage[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

export async function processScanJob(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
  const { scanId, workspaceId, targetId, goal, mode, policyId } = job.data
  const log = logger

  log.info("Processing scan job", { scanId, targetId, goal, mode, jobId: job.id })

  // Wrap the entire job in workspace context so the Prisma client extension's
  // auto-scoping safety net is active for all DB queries. Without this, a
  // missed manual workspaceId filter could leak cross-tenant data.
  return runWithWorkspaceContext(workspaceId, async () => {
    try {
      // 1. Preflight checks
      await updateScanStatus(scanId, "PREFLIGHT" as ScanStatus)
      const preflight = await runPreflight(scanId, targetId)

      if (!preflight.passed) {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: preflight.errorCategory,
          errorMessage: preflight.errorMessage,
        })
        return {
          status: "failed",
          errorCategory: preflight.errorCategory,
          errorMessage: preflight.errorMessage,
        }
      }

      // 2. Fetch target details for the engine
      const target = await prisma.target.findFirst({
        where: { id: targetId, deletedAt: null },
      })

      if (!target) {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "TARGET_NOT_FOUND",
          errorMessage: "Target disappeared between preflight and execution",
        })
        return {
          status: "failed",
          errorCategory: "TARGET_NOT_FOUND",
          errorMessage: "Target not found",
        }
      }

      // 3. Run the scan engine
      await updateScanStatus(scanId, "RUNNING" as ScanStatus)

      const policy = policyId
        ? await prisma.policy.findFirst({
            where: { id: policyId, workspaceId, deletedAt: null },
            select: { maxBudgetUsd: true },
          })
        : null
      const policyMaxBudgetUsd = policy?.maxBudgetUsd?.toNumber()
      const maxBudgetUsd = resolveScanBudgetUsd(mode, policyMaxBudgetUsd)
      const budgetSource =
        typeof policyMaxBudgetUsd === "number" &&
        Number.isFinite(policyMaxBudgetUsd) &&
        policyMaxBudgetUsd > 0
          ? "policy"
          : "mode_default"

      try {
        await addScanEvent(
          scanId,
          "budget_cap",
          "info",
          `Engine spend capped at $${maxBudgetUsd.toFixed(2)}`,
          { maxBudgetUsd, source: budgetSource }
        )
      } catch (eventErr) {
        log.warn("Failed to persist budget_cap event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      const engineResult: EngineRunResult =
        target.type === "REPO"
          ? await runEngine(
              {
                scanId,
                goal,
                mode,
                target: {
                  id: target.id,
                  type: target.type as TargetType,
                  url: target.url,
                  repoFullName: target.repoFullName,
                  name: target.name,
                },
                instruction: buildVibeSecurityInstruction(goal),
                maxBudgetUsd,
              },
              scanId,
              undefined,
              async () => {
                const current = await prisma.scan.findUnique({
                  where: { id: scanId },
                  select: { status: true },
                })
                return current?.status === "CANCELLED"
              }
            )
          : {
              exitCode: 0,
              cancelled: false,
              timedOut: false,
              stdout: "",
              stderr: "",
              sourceCheckoutPath: null,
              output: {
                vulnerabilities: [],
                runRecord: null,
                findingCount: 0,
                summary: "URL target scanned through the pinned deterministic URL scanner.",
              },
            }

      if (target.type !== "REPO") {
        await addScanEvent(
          scanId,
          "engine_skipped",
          "info",
          "External engine skipped for URL targets until it supports pinned transport",
          { targetType: target.type }
        )
      }

      if (engineResult.cancelled) {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }

      if (engineResult.timedOut) {
        const timeoutMessage = "Scan engine timed out before completing"
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
        return { status: "failed", errorCategory: "TIMEOUT", errorMessage: timeoutMessage }
      }

      // 4. Run scanner orchestrator (SCA + secrets + normalization)
      await updateScanStatus(scanId, "VERIFYING" as ScanStatus)

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
        },
        goal,
        mode,
        engineFindings: engineResult.output.vulnerabilities,
        workspaceDir: engineResult.sourceCheckoutPath ?? undefined,
        isCancelled: async () => {
          const current = await prisma.scan.findUnique({
            where: { id: scanId },
            select: { status: true },
          })
          return current?.status === "CANCELLED"
        },
      })

      try {
        await addScanEvent(
          scanId,
          "scanners_complete",
          "info",
          `Scan phases complete: engine=${orchestratorResult.engineFindings.length}, sca=${orchestratorResult.scaFindings.length}, secrets=${orchestratorResult.secretsFindings.length}, url=${orchestratorResult.urlFindings.length}, agent_config=${orchestratorResult.agentConfigFindings.length}, false_positives_filtered=${orchestratorResult.filteredFalsePositives}`,
          {
            engine: orchestratorResult.engineFindings.length,
            sca: orchestratorResult.scaFindings.length,
            secrets: orchestratorResult.secretsFindings.length,
            url: orchestratorResult.urlFindings.length,
            agentConfig: orchestratorResult.agentConfigFindings.length,
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
          `Vibe Security 50: ${coverage.machineControlsRequested} machine-testable controls requested where applicable; ${coverage.matchedControlRanks.length} produced findings; ${coverage.evidenceControlsRequired} require deployment or human evidence`,
          coverage
        )
      } catch (eventErr) {
        log.warn("Failed to persist coverage_contract event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      // Persist LLM usage data from engine run record for cost observability
      if (engineResult.output.runRecord?.llm_usage) {
        const actualCostUsd = extractActualCostUsd(engineResult.output.runRecord.llm_usage)
        try {
          await addScanEvent(
            scanId,
            "llm_usage",
            "info",
            `LLM usage: ${JSON.stringify(engineResult.output.runRecord.llm_usage)}`,
            { llm_usage: engineResult.output.runRecord.llm_usage }
          )
        } catch (eventErr) {
          log.warn("Failed to persist llm_usage event", {
            scanId,
            error: eventErr instanceof Error ? eventErr.message : String(eventErr),
          })
        }
        if (actualCostUsd !== null) {
          await prisma.scan.update({
            where: { id: scanId },
            data: { actualCostCents: Math.round(actualCostUsd * 100) },
          })
          if (actualCostUsd > maxBudgetUsd) {
            log.warn("Engine reported spend above worker budget cap", {
              scanId,
              actualCostUsd,
              maxBudgetUsd,
            })
            await addScanEvent(
              scanId,
              "budget_exceeded",
              "error",
              "Engine reported spend above the worker budget cap",
              { actualCostUsd, maxBudgetUsd }
            )
          }
        }
      }

      // 5. Persist normalized findings
      const persistedFindings = await persistFindings({
        scanId,
        workspaceId,
        targetId,
        vulnerabilities: orchestratorResult.allFindings,
      })

      const newFindings = persistedFindings.filter((f) => f.isNew).length
      const dupFindings = persistedFindings.length - newFindings

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
        log.warn("Failed to persist findings_persisted event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      // 6. Interpret exit code and finalize
      const exitInterpretation = interpretExitCode(engineResult.exitCode)

      if (exitInterpretation.status === "FAILED") {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: exitInterpretation.category,
          errorMessage: exitInterpretation.message,
          summary: engineResult.output.summary,
        })
        try {
          await notifyScanFailed(workspaceId, scanId, exitInterpretation.message)
        } catch (notificationError) {
          log.warn("Failed to send scan failure notification", {
            scanId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          })
        }
        return {
          status: "failed",
          errorCategory: exitInterpretation.category,
          errorMessage: exitInterpretation.message,
        }
      }

      await completeScanWithScore(scanId, engineResult.output.summary)
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
          notifyScanCompleted(
            workspaceId,
            scanId,
            engineResult.output.summary,
            persistedFindings.length
          ),
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
        summary: engineResult.output.summary,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCategory = error instanceof Error ? error.name : "UNKNOWN"

      log.error("Scan job failed", { scanId, error: errorMessage })

      const currentScan = await prisma.scan
        .findUnique({
          where: { id: scanId },
          select: { status: true },
        })
        .catch(() => null)
      if (currentScan?.status === "CANCELLED") {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
      }

      const maxAttempts = job.opts?.attempts ?? 1
      const isTerminalPrerequisiteFailure = error instanceof EvidenceStorageConfigurationError
      if (!isTerminalPrerequisiteFailure && (job.attemptsMade ?? 0) + 1 < maxAttempts) {
        log.warn("Scan job failed and will be retried", {
          scanId,
          attempt: (job.attemptsMade ?? 0) + 1,
          maxAttempts,
        })
        throw error
      }

      try {
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory,
          errorMessage,
        })
      } catch (updateErr) {
        log.error("Failed to update scan status on error", {
          scanId,
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        })
      }

      return {
        status: "failed",
        errorCategory,
        errorMessage,
      }
    } finally {
      try {
        await cleanupEngineWorkspace(`lyrashield_runs/${scanId}`)
      } catch {
        // Non-fatal — workspace cleanup is best-effort
      }
    }
  }) // end runWithWorkspaceContext
}
