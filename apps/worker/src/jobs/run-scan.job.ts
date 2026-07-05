import type { Job } from "bullmq"
import { prisma, runWithWorkspaceContext } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  updateScanStatus,
  addScanEvent,
  type ScanStatus,
} from "@lyrashield/db"
import { runPreflight } from "./preflight.job"
import { runEngine, cleanupEngineWorkspace, interpretExitCode } from "../engine/runner"
import type { TargetType } from "../engine/command-builder"
import { persistFindings } from "../engine/finding-persister"
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
      return { status: "failed", errorCategory: "TARGET_NOT_FOUND", errorMessage: "Target not found" }
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
    )

    // 4. Verify and persist findings
    await updateScanStatus(scanId, "VERIFYING" as ScanStatus)

    const persistedFindings = await persistFindings({
      scanId,
      workspaceId,
      targetId,
      vulnerabilities: engineResult.output.vulnerabilities,
    })

    const newFindings = persistedFindings.filter((f) => f.isNew).length
    const dupFindings = persistedFindings.length - newFindings

    try {
      await addScanEvent(scanId, "findings_persisted", "info", `Persisted ${persistedFindings.length} finding(s): ${newFindings} new, ${dupFindings} duplicate`, {
        total: persistedFindings.length,
        new: newFindings,
        duplicate: dupFindings,
      })
    } catch (eventErr) {
      log.warn("Failed to persist findings_persisted event", {
        scanId,
        error: eventErr instanceof Error ? eventErr.message : String(eventErr),
      })
    }

    // 5. Interpret exit code and finalize
    const exitInterpretation = interpretExitCode(engineResult.exitCode)

    if (exitInterpretation.status === "FAILED") {
      await updateScanStatus(scanId, "FAILED" as ScanStatus, {
        errorCategory: exitInterpretation.category,
        errorMessage: exitInterpretation.message,
        summary: engineResult.output.summary,
      })
      return {
        status: "failed",
        errorCategory: exitInterpretation.category,
        errorMessage: exitInterpretation.message,
      }
    }

    await updateScanStatus(scanId, "COMPLETED" as ScanStatus, {
      summary: engineResult.output.summary,
    })

    log.info("Scan job completed", {
      scanId,
      targetId,
      exitCode: engineResult.exitCode,
      findings: persistedFindings.length,
      newFindings,
    })

    return {
      status: "completed",
      summary: engineResult.output.summary,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorCategory = error instanceof Error ? error.name : "UNKNOWN"

    log.error("Scan job failed", { scanId, error: errorMessage })

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
