import { prisma, updateScanStatus, type ScanStatus } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { checkInstructionSafety } from "@lyrashield/security"
import {
  resolveTargetScanMode,
  type ScanExecutionPlan,
  type UrlScanProfile,
} from "@lyrashield/types"
import { assertEvidenceStorageConfigured } from "../../engine/evidence-storage"
import type { TargetType } from "../../engine/command-builder"
import { runPreflight } from "../preflight.job"
import type { ScanJobData, ScanJobResult } from "../../types"

export interface ScanExecutionTarget {
  id: string
  type: TargetType
  name: string
  url: string | null
  repoFullName: string | null
  branch: string | null
  apiSpecUrl: string | null
  environment: string | null
  installationId: string | null
  repoProvider: string | null
}

export type ScanPreparationResult =
  | { ok: true; target: ScanExecutionTarget; urlProfile?: UrlScanProfile }
  | { ok: false; result: ScanJobResult }

export async function prepareScanExecution(params: {
  scanId: string
  targetId: string
  goal: string
  mode: ScanJobData["mode"]
  /**
   * Stored execution plan already hash-validated by verifyScanJobAuthority
   * (verifyStoredScanExecutionPlan). A DIFF-scope plan — the Review Changes
   * workflow — must still name all three immutable source revisions on a
   * repository target before any provider work; missing provenance is a
   * named preflight failure, never a silent fallback to a snapshot scan of
   * a different change set than the one the plan recorded.
   */
  executionPlan?: ScanExecutionPlan | null
}): Promise<ScanPreparationResult> {
  const { scanId, targetId, goal, mode, executionPlan } = params

  // 1. Preflight checks
  await updateScanStatus(scanId, "PREFLIGHT" as ScanStatus)
  const preflight = await runPreflight(scanId, targetId)

  if (!preflight.passed) {
    await updateScanStatus(scanId, "FAILED" as ScanStatus, {
      errorCategory: preflight.errorCategory,
      errorMessage: preflight.errorMessage,
    })
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: preflight.errorCategory,
        errorMessage: preflight.errorMessage,
      },
    }
  }

  // 2. Fetch target details for the engine
  const target = await prisma.target.findFirst({
    where: { id: targetId, deletedAt: null },
    select: {
      id: true,
      type: true,
      name: true,
      url: true,
      repoFullName: true,
      branch: true,
      apiSpecUrl: true,
      environment: true,
      installationId: true,
      repoProvider: true,
    },
  })

  if (!target) {
    await updateScanStatus(scanId, "FAILED" as ScanStatus, {
      errorCategory: "TARGET_NOT_FOUND",
      errorMessage: "Target disappeared between preflight and execution",
    })
    return {
      ok: false,
      result: {
        status: "failed",
        errorCategory: "TARGET_NOT_FOUND",
        errorMessage: "Target not found",
      },
    }
  }

  // Review Changes fail-closed guard: a DIFF-scope plan must name the head,
  // requested base, and effective merge base as full object IDs against a
  // repository target. A plan that reaches here without them is malformed
  // (or the target changed type); the scan fails with a named preflight
  // category rather than silently scanning a full snapshot — that would
  // analyze a different change set than the recorded comparison.
  if (executionPlan?.scope === "DIFF" || executionPlan?.workflow === "REVIEW_CHANGES") {
    const source = executionPlan.source
    if (
      target.type !== "REPO" ||
      !source?.revision ||
      !source.baseRevision ||
      !source.mergeBaseRevision
    ) {
      const errorMessage =
        "Stored execution plan is missing the immutable source revisions a Review Changes run requires"
      logger.warn("Review Changes plan lacks immutable source provenance", {
        scanId,
        targetType: target.type,
        hasRevision: Boolean(source?.revision),
        hasBaseRevision: Boolean(source?.baseRevision),
        hasMergeBaseRevision: Boolean(source?.mergeBaseRevision),
      })
      await updateScanStatus(scanId, "FAILED" as ScanStatus, {
        errorCategory: "SCAN_PLAN_INVALID",
        errorMessage,
      })
      return {
        ok: false,
        result: {
          status: "failed",
          errorCategory: "SCAN_PLAN_INVALID",
          errorMessage,
        },
      }
    }
  }

  let urlProfile: UrlScanProfile | undefined
  if (target.type === "WEB_APP" || target.type === "API") {
    const resolved = resolveTargetScanMode({
      targetType: target.type,
      mode,
      hasApiSpec: Boolean(target.apiSpecUrl),
    })
    if (!resolved.ok) {
      await updateScanStatus(scanId, "FAILED" as ScanStatus, {
        errorCategory: resolved.code,
        errorMessage: resolved.reason,
      })
      return {
        ok: false,
        result: {
          status: "failed",
          errorCategory: resolved.code,
          errorMessage: resolved.reason,
        },
      }
    }
    urlProfile = resolved.profile ?? undefined
  }

  // Reject prompt-injection patterns in user-controlled fields before they
  // reach the engine prompt. This is fail-fast, before any provider spend.
  const goalSafety = checkInstructionSafety(goal)
  const targetNameSafety = checkInstructionSafety(target.name ?? "")
  if (!goalSafety.safe || !targetNameSafety.safe) {
    const patterns = [
      ...new Set([...goalSafety.detectedPatterns, ...targetNameSafety.detectedPatterns]),
    ]
    const reason = `Prompt injection risk detected in scan input: ${patterns.join(", ")}`
    logger.warn("Scan rejected due to prompt injection risk", {
      scanId,
      patterns,
      goalSafe: goalSafety.safe,
      targetNameSafe: targetNameSafety.safe,
    })
    await updateScanStatus(scanId, "FAILED" as ScanStatus, {
      errorCategory: "PROMPT_INJECTION",
      errorMessage: reason,
    })
    return {
      ok: false,
      result: { status: "failed", errorCategory: "PROMPT_INJECTION", errorMessage: reason },
    }
  }

  // Evidence is part of the result contract. Refuse before provider work
  // when it cannot be retained durably.
  assertEvidenceStorageConfigured()

  return { ok: true, target: target as ScanExecutionTarget, urlProfile }
}
