import type { Job } from "bullmq"
import { prisma, runWithWorkspaceContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  updateScanStatus,
  addScanEvent,
  completeScanWithScore,
  qualifyReferralForWorkspace,
  type ScanStatus,
} from "@lyrashield/db"
import { runPreflight } from "./preflight.job"
import { runEngine, cleanupEngineWorkspace, interpretExitCode } from "../engine/runner"
import type { TargetType } from "../engine/command-builder"
import { persistFindings } from "../engine/finding-persister"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import { notifyScanCompleted, notifyScanFailed, notifyCriticalFinding } from "../notifications"
import type { ScanJobData, ScanJobResult } from "../types"

export async function processScanJob(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
  const { scanId, workspaceId, targetId, goal, mode } = job.data
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

      const engineResult = await runEngine(
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

      if (engineResult.cancelled) {
        return {
          status: "failed",
          errorCategory: "CANCELLED",
          errorMessage: "Scan cancelled by user",
        }
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
        workspaceDir: `lyrashield_runs/${scanId}`,
      })

      try {
        await addScanEvent(
          scanId,
          "scanners_complete",
          "info",
          `Scan phases complete: engine=${orchestratorResult.engineFindings.length}, sca=${orchestratorResult.scaFindings.length}, secrets=${orchestratorResult.secretsFindings.length}, false_positives_filtered=${orchestratorResult.filteredFalsePositives}`,
          {
            engine: orchestratorResult.engineFindings.length,
            sca: orchestratorResult.scaFindings.length,
            secrets: orchestratorResult.secretsFindings.length,
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

      // Persist LLM usage data from engine run record for cost observability
      if (engineResult.output.runRecord?.llm_usage) {
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
      await qualifyReferralForWorkspace(workspaceId)

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
      if ((job.attemptsMade ?? 0) + 1 < maxAttempts) {
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
