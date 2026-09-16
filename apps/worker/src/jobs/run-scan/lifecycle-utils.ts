import { hasUnsettledScanIntent } from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { evaluateGateForTarget } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { resolveScanProfile } from "@lyrashield/types"
import type { TargetType } from "../../engine/command-builder"
import type { ScanJobData } from "../../types"

export type StoredTerminalOutcome = {
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "STOPPED_BUDGET"
  errorCategory: string | null
  errorMessage: string | null
}

export function storedTerminalOutcome(manifest: unknown): StoredTerminalOutcome | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null
  const outcome = (manifest as { terminalOutcome?: unknown }).terminalOutcome
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null
  const record = outcome as Record<string, unknown>
  if (!["COMPLETED", "PARTIAL", "FAILED", "STOPPED_BUDGET"].includes(String(record.status))) {
    return null
  }
  if (
    record.errorCategory !== null &&
    record.errorCategory !== undefined &&
    typeof record.errorCategory !== "string"
  ) {
    return null
  }
  if (
    record.errorMessage !== null &&
    record.errorMessage !== undefined &&
    typeof record.errorMessage !== "string"
  ) {
    return null
  }
  return {
    status: record.status as StoredTerminalOutcome["status"],
    errorCategory: typeof record.errorCategory === "string" ? record.errorCategory : null,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
  }
}

export async function reportInterruptedSettlement(
  workspaceId: string,
  scanId: string
): Promise<void> {
  let checkUnavailable = false
  const pending = await hasUnsettledScanIntent(workspaceId, scanId).catch(() => {
    checkUnavailable = true
    return true
  })
  if (pending) {
    logger.error("billing.scan_settlement_commit_uncertain", {
      workspaceId,
      scanId,
      accountingReviewRequired: true,
      automaticReplayAllowed: false,
      checkUnavailable,
    })
  }
}

export const MAX_SCAN_RUNTIME_MS = 30 * 60 * 1000

export function resolveScanRuntimeBudgetMs(
  mode: ScanJobData["mode"],
  maxDurationMinutes: number | null | undefined,
  targetType = "REPO"
): number {
  let modeMaxMs = MAX_SCAN_RUNTIME_MS
  try {
    modeMaxMs = resolveScanProfile({ targetType, mode }).maxDurationMinutes * 60 * 1000
  } catch {
    // A historical invalid row must not turn a worker retry into an unbounded run.
    modeMaxMs = MAX_SCAN_RUNTIME_MS
  }
  const configuredMaxMs =
    typeof maxDurationMinutes === "number" &&
    Number.isFinite(maxDurationMinutes) &&
    maxDurationMinutes > 0
      ? Math.floor(maxDurationMinutes * 60 * 1000)
      : modeMaxMs

  return Math.min(configuredMaxMs, modeMaxMs)
}

export function resolveScannerPhaseTimeoutMs(
  globalScanBudgetMs: number,
  elapsedMs: number
): number {
  // ponytail: spend only the wall-clock time the engine actually used.
  return Math.max(0, Math.min(env.SCANNER_PHASE_TIMEOUT_MS, globalScanBudgetMs - elapsedMs))
}

export function resolveEngineRuntimeBudgetMs(
  mode: ScanJobData["mode"],
  targetType: TargetType,
  scanRuntimeBudgetMs: number,
  elapsedMs: number
): number {
  try {
    const profile = resolveScanProfile({ targetType, mode })
    // Deterministic-only profiles carry no engine budget — the caller never
    // reaches here for them.
    if (!profile.usesAi || profile.maxEngineMinutes <= 0) {
      return Math.max(0, scanRuntimeBudgetMs - elapsedMs)
    }
    const engineCapMs = profile.maxEngineMinutes * 60 * 1000
    const scannerReserveMs = profile.scannerReserveMinutes * 60 * 1000
    return Math.max(0, Math.min(engineCapMs, scanRuntimeBudgetMs - elapsedMs - scannerReserveMs))
  } catch {
    return Math.max(0, scanRuntimeBudgetMs - elapsedMs)
  }
}

export function requireEngineModel(model: string | undefined): string {
  if (!model) {
    throw new Error("A GPT-5.6 Terra or Luna deployment must be configured for engine-backed scans")
  }
  return model
}

export function timeoutErrorMessage(totalRuntimeMs: number): string {
  const minutes = Math.max(1, Math.ceil(totalRuntimeMs / 60_000))
  return `Scan exceeded the configured runtime limit of ${minutes} minute(s)`
}

export function imageDigest(image: string | undefined): string | undefined {
  return image?.match(/@?(sha256:[a-f0-9]{64})$/i)?.[1]?.toLowerCase()
}

/**
 * WP2 gate maintenance: re-evaluate the Launch Gate verdict for a target after
 * a scan reaches a terminal state. A completed scan adds evidence (verdict may
 * move toward READY); a failed/stopped scan changes the staleness picture. The
 * verdict is derived purely from stored evidence, so this is a best-effort
 * refresh — a gate failure must never fail or retry a scan that already
 * finalized. No-op for scans without a target.
 */
export async function refreshGateVerdictAfterTerminalScan(
  workspaceId: string,
  targetId: string | null | undefined,
  scanId: string
): Promise<void> {
  if (!targetId) return
  try {
    await evaluateGateForTarget(workspaceId, targetId)
  } catch (error) {
    logger.warn("Post-scan gate evaluation failed (non-fatal)", {
      scanId,
      targetId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true

  const message = error.message.toLowerCase()
  return message.includes("timeout") || message.includes("timed out")
}
