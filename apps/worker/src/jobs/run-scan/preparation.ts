import { prisma, updateScanStatus, type ScanStatus } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { checkInstructionSafety } from "@lyrashield/security"
import { resolveTargetScanMode, type UrlScanProfile } from "@lyrashield/types"
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
}): Promise<ScanPreparationResult> {
  const { scanId, targetId, goal, mode } = params

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
