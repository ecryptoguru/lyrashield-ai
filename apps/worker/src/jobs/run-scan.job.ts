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
  resolveEngineProfile,
  type EngineRunResult,
} from "../engine/runner"
import { resolveScanBudgetUsd, type TargetType } from "../engine/command-builder"
import {
  calculateGpt56CostUsd,
  calculateGpt56CostUsdFromBuckets,
  GPT_56_PRICING_EFFECTIVE_DATE,
  GPT_56_PRICING_SOURCE,
} from "../engine/gpt56-pricing"
import { persistFindings } from "../engine/finding-persister"
import { EvidenceStorageConfigurationError } from "../engine/evidence-storage"
import { runScannerOrchestrator } from "../engine/scanner-orchestrator"
import {
  completeRetestsForScan,
  failTerminalRetestsForScan,
  markRetestsRunning,
  persistResultManifest,
} from "../engine/result-integrity"
import { notifyScanCompleted, notifyScanFailed, notifyCriticalFinding } from "../notifications"
import type { ScanJobData, ScanJobResult } from "../types"

export function extractActualCostUsd(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null
  for (const key of ["total_cost_usd", "cost_usd", "total_cost", "cost"]) {
    const value = usage[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1_000_000) {
      return value
    }
  }
  return null
}

type UsageSummary = {
  requestCount: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteInputTokens: number | null
  outputTokens: number | null
  pricingBuckets: {
    standardInputTokens: number | null
    standardCachedInputTokens: number | null
    standardCacheWriteInputTokens: number | null
    standardOutputTokens: number | null
    longInputTokens: number | null
    longCachedInputTokens: number | null
    longCacheWriteInputTokens: number | null
    longOutputTokens: number | null
  } | null
  engineReportedCostUsd: number | null
}

function usageCount(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key]
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null
}

export function extractUsageSummary(usage: Record<string, unknown>): UsageSummary {
  const pricingBuckets = {
    standardInputTokens: usageCount(usage, "standard_input_tokens"),
    standardCachedInputTokens: usageCount(usage, "standard_cached_input_tokens"),
    standardCacheWriteInputTokens: usageCount(usage, "standard_cache_write_input_tokens"),
    standardOutputTokens: usageCount(usage, "standard_output_tokens"),
    longInputTokens: usageCount(usage, "long_input_tokens"),
    longCachedInputTokens: usageCount(usage, "long_cached_input_tokens"),
    longCacheWriteInputTokens: usageCount(usage, "long_cache_write_input_tokens"),
    longOutputTokens: usageCount(usage, "long_output_tokens"),
  }
  return {
    requestCount: usageCount(usage, "request_count"),
    inputTokens: usageCount(usage, "input_tokens"),
    cachedInputTokens: usageCount(usage, "cached_input_tokens"),
    cacheWriteInputTokens: usageCount(usage, "cache_write_input_tokens"),
    outputTokens: usageCount(usage, "output_tokens"),
    pricingBuckets: Object.values(pricingBuckets).every((value) => value !== null)
      ? pricingBuckets
      : null,
    engineReportedCostUsd: extractActualCostUsd(usage),
  }
}

export async function processScanJob(job: Job<ScanJobData, ScanJobResult>): Promise<ScanJobResult> {
  const { scanId, workspaceId, targetId, goal, mode, policyId } = job.data
  const log = logger

  log.info("Processing scan job", { scanId, targetId, goal, mode, jobId: job.id })

  // Wrap the entire job in workspace context so the Prisma client extension's
  // auto-scoping safety net is active for all DB queries. Without this, a
  // missed manual workspaceId filter could leak cross-tenant data.
  return runWithWorkspaceContext(workspaceId, async () => {
    let billablePhaseStarted = false
    try {
      // A manifest is the immutable checkpoint after findings and retests have
      // been persisted. If an infrastructure error interrupted only the final
      // score transition, resume that transition without replaying a billable
      // scan or comparing a fresh result against the original manifest.
      const pendingFinalization = await prisma.scan.findUnique({
        where: { id: scanId },
        select: {
          status: true,
          summary: true,
          errorCategory: true,
          errorMessage: true,
          actualCostCents: true,
          resultManifest: { select: { id: true } },
          events: {
            where: { stage: "billable_boundary" },
            select: { id: true },
            take: 1,
          },
        },
      })
      if (pendingFinalization?.status === "VERIFYING" && pendingFinalization.resultManifest) {
        if (pendingFinalization.errorCategory === "BUDGET_EXCEEDED") {
          await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: pendingFinalization.errorMessage ?? "Protected run limit reached",
            ...(pendingFinalization.actualCostCents !== null
              ? { actualCostCents: pendingFinalization.actualCostCents }
              : {}),
          })
          return {
            status: "failed",
            errorCategory: "BUDGET_EXCEEDED",
            errorMessage: "Protected run limit reached",
          }
        }
        await completeScanWithScore(scanId, pendingFinalization.summary)
        try {
          await qualifyReferralForWorkspace(workspaceId)
        } catch (referralError) {
          log.warn("Failed to qualify referral after resumed scan completion", {
            scanId,
            error: referralError instanceof Error ? referralError.message : String(referralError),
          })
        }
        return { status: "completed", summary: pendingFinalization.summary ?? "Scan completed" }
      }
      if (
        ["RUNNING", "VERIFYING"].includes(pendingFinalization?.status ?? "") &&
        pendingFinalization?.events?.length
      ) {
        const interruptedMessage =
          "Provider-billable analysis was interrupted and was not replayed automatically"
        await updateScanStatus(scanId, "FAILED" as ScanStatus, {
          errorCategory: "BILLABLE_PHASE_INTERRUPTED",
          errorMessage: interruptedMessage,
        })
        return {
          status: "failed",
          errorCategory: "BILLABLE_PHASE_INTERRUPTED",
          errorMessage: interruptedMessage,
        }
      }

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
      await markRetestsRunning(scanId)

      const policy = policyId
        ? await prisma.policy.findFirst({
            where: { id: policyId, workspaceId, deletedAt: null },
            select: { maxBudgetUsd: true },
          })
        : null
      const policyMaxBudgetUsd = policy?.maxBudgetUsd?.toNumber()
      const maxBudgetUsd = resolveScanBudgetUsd(mode, policyMaxBudgetUsd)
      const engineProfile = resolveEngineProfile(mode)
      const budgetSource =
        typeof policyMaxBudgetUsd === "number" &&
        Number.isFinite(policyMaxBudgetUsd) &&
        policyMaxBudgetUsd > 0
          ? "policy"
          : "mode_default"

      try {
        await addScanEvent(scanId, "budget_cap", "info", "Protected run limit enabled", {
          maxBudgetUsd,
          source: budgetSource,
        })
      } catch (eventErr) {
        log.warn("Failed to persist budget_cap event", {
          scanId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        })
      }

      if (target.type === "REPO") {
        // Once the external engine begins, an automatic BullMQ replay could
        // spend twice for the same scan. Preflight remains retryable; the
        // billable phase is terminal and any rerun requires a fresh scan.
        await addScanEvent(
          scanId,
          "billable_boundary",
          "info",
          "Automatic retries disabled before provider-billable analysis",
          { retryPolicy: "fresh_scan_required" }
        )
        billablePhaseStarted = true
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

      let budgetExceeded = false
      let billedCostUsd: number | null = null

      // Persist only normalized provider usage counters. Prompts, responses,
      // and per-request payloads never enter the scan ledger.
      if (engineResult.output.runRecord?.llm_usage) {
        const usage = extractUsageSummary(engineResult.output.runRecord.llm_usage)
        const rateCardCostUsd = usage.pricingBuckets
          ? calculateGpt56CostUsdFromBuckets(engineProfile.model, usage.pricingBuckets)
          : calculateGpt56CostUsd(engineProfile.model, usage)
        // Provider telemetry is useful for reconciliation, but it is not an
        // independently auditable invoice. Use the higher known amount for
        // the cap so a stale provider cost map can never understate spend.
        const billableCostUsd =
          Math.max(usage.engineReportedCostUsd ?? 0, rateCardCostUsd ?? 0) || null
        const costSource =
          rateCardCostUsd !== null && usage.engineReportedCostUsd !== null
            ? "rate_card_and_engine_reported"
            : rateCardCostUsd !== null
              ? "openai_rate_card"
              : usage.engineReportedCostUsd !== null
                ? "engine_reported_unreconciled"
                : "unavailable"
        const reconciliationStatus =
          rateCardCostUsd !== null && usage.engineReportedCostUsd !== null
            ? Math.abs(rateCardCostUsd - usage.engineReportedCostUsd) < 0.000001
              ? "matched"
              : "mismatch"
            : "unavailable"
        billedCostUsd = billableCostUsd === null ? null : Math.min(billableCostUsd, maxBudgetUsd)
        try {
          await addScanEvent(scanId, "llm_usage", "info", "AI usage counters recorded", {
            ...usage,
            calculatedCostUsd: rateCardCostUsd,
            pricingMethod: usage.pricingBuckets ? "per_request_buckets" : "aggregate_standard_only",
            billedCostUsd,
            costSource,
            reconciliationStatus,
            ...(rateCardCostUsd !== null
              ? {
                  pricingEffectiveDate: GPT_56_PRICING_EFFECTIVE_DATE,
                  pricingSource: GPT_56_PRICING_SOURCE,
                }
              : {}),
          })
        } catch (eventErr) {
          log.warn("Failed to persist llm_usage event", {
            scanId,
            error: eventErr instanceof Error ? eventErr.message : String(eventErr),
          })
        }
        await prisma.scan.update({
          where: { id: scanId },
          data: {
            ...(usage.engineReportedCostUsd !== null
              ? {
                  providerCostUsd: usage.engineReportedCostUsd.toFixed(6),
                }
              : {}),
            ...(billedCostUsd !== null
              ? {
                  billedCostUsd: billedCostUsd.toFixed(6),
                  actualCostCents: Math.round(billedCostUsd * 100),
                }
              : {}),
            llmRequestCount: usage.requestCount,
            llmInputTokens: usage.inputTokens,
            llmCachedInputTokens: usage.cachedInputTokens,
            llmOutputTokens: usage.outputTokens,
          },
        })
        if (billableCostUsd !== null && billableCostUsd > maxBudgetUsd) {
          budgetExceeded = true
          log.warn("Engine reported spend above worker budget cap", {
            scanId,
            billableCostUsd,
            maxBudgetUsd,
          })
          await addScanEvent(scanId, "budget_exceeded", "error", "Protected run limit reached", {
            billableCostUsd,
            billedCostUsd,
            maxBudgetUsd,
          })
          await prisma.scan.update({
            where: { id: scanId },
            data: {
              errorCategory: "BUDGET_EXCEEDED",
              errorMessage: "Protected run limit reached",
              actualCostCents: Math.round(billedCostUsd! * 100),
            },
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

      if (budgetExceeded) {
        await prisma.scan.update({
          where: { id: scanId },
          data: { summary: engineResult.output.summary },
        })
        await persistResultManifest({
          scanId,
          target: {
            id: target.id,
            type: target.type,
            repoFullName: target.repoFullName,
            branch: target.branch,
            url: target.url,
          },
          sourceCheckoutAvailable: Boolean(engineResult.sourceCheckoutPath),
          engineFindingCount: orchestratorResult.engineFindings.length,
          coverageIssues: orchestratorResult.coverageIssues,
          matchedControlRanks: coverage.matchedControlRanks,
        })
        await updateScanStatus(scanId, "STOPPED_BUDGET" as ScanStatus, {
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
          actualCostCents: Math.round(billedCostUsd! * 100),
        })
        return {
          status: "failed",
          errorCategory: "BUDGET_EXCEEDED",
          errorMessage: "Protected run limit reached",
        }
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

      await completeRetestsForScan({
        scanId,
        workspaceId,
        persistedFindingIds: persistedFindings.map((finding) => finding.id),
        coverageIssues: orchestratorResult.coverageIssues,
      })
      // Persist the user-facing summary before the immutable checkpoint so a
      // resumed finalization retains the completed scan's original context.
      await prisma.scan.update({
        where: { id: scanId },
        data: { summary: engineResult.output.summary },
      })
      await persistResultManifest({
        scanId,
        target: {
          id: target.id,
          type: target.type,
          repoFullName: target.repoFullName,
          branch: target.branch,
          url: target.url,
        },
        sourceCheckoutAvailable: Boolean(engineResult.sourceCheckoutPath),
        engineFindingCount: orchestratorResult.engineFindings.length,
        coverageIssues: orchestratorResult.coverageIssues,
        matchedControlRanks: coverage.matchedControlRanks,
      })
      // Retests may validate a pending fix and change the target's scoreable
      // state. Freeze the score only after those outcomes are persisted.
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
        await failTerminalRetestsForScan(scanId)
      } catch (retestError) {
        log.warn("Failed to finalize retest state", {
          scanId,
          error: retestError instanceof Error ? retestError.message : String(retestError),
        })
      }
      try {
        await cleanupEngineWorkspace(`lyrashield_runs/${scanId}`)
      } catch {
        // Non-fatal — workspace cleanup is best-effort
      }
    }
  }) // end runWithWorkspaceContext
}
