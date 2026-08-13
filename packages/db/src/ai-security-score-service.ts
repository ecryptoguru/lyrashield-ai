import {
  computeAiSecurityScore,
  type AIScoreCandidate,
  type AISecurityCoverage,
  type AISecuritySignal,
} from "@lyrashield/security/ai-security"
import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import { withWorkspaceRLS } from "./rls"

export interface AiSecurityScoreInput {
  signals?: AISecuritySignal[]
  candidates?: AIScoreCandidate[]
  coverage: AISecurityCoverage
  detectorVersion?: string
  ai03: {
    resolutionStatus: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
    advisoryStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"
    fresh: boolean
    snapshotId?: string | null
    snapshotChecksum?: string | null
  }
  triage?: {
    status: "COMPLETED" | "DISABLED" | "FAILED" | "BUDGET_STOPPED"
    terminalReason: string | null
    policyVersion: string
    modelRoute: string
    inputChecksum: string
    redactionReceipt: string
    resultCount: number
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function inputChecksum(input: AiSecurityScoreInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        signals: input.signals ?? [],
        candidates: input.candidates ?? [],
        coverage: input.coverage,
        ai03: input.ai03,
        triage: input.triage ?? null,
        detectorVersion: input.detectorVersion ?? input.coverage.version,
      })
    )
    .digest("hex")
}

/** Creates an immutable, workspace-scored AI App Security snapshot for a scan. */
export async function createAiSecurityScoreSnapshot(
  scanId: string,
  workspaceId: string,
  input: AiSecurityScoreInput
) {
  const scoreResult = computeAiSecurityScore({
    signals: input.signals,
    candidates: input.candidates,
    coverage: input.coverage,
    ai03: input.ai03,
  })
  const scoreInputChecksum = inputChecksum(input)
  const detectorVersion = input.detectorVersion ?? input.coverage.version

  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
      select: { targetId: true, status: true },
    })
    if (!scan || !scan.targetId) {
      throw new Error("Scan or target not found")
    }

    const existing = await tx.aiSecurityScoreSnapshot.findFirst({
      where: { scanId, workspaceId },
    })
    if (existing) {
      return { snapshot: existing, created: false }
    }

    const now = new Date()
    const snapshot = await tx.aiSecurityScoreSnapshot.create({
      data: {
        workspaceId,
        targetId: scan.targetId,
        scanId,
        modelVersion: scoreResult.methodologyVersion,
        score: scoreResult.score,
        breakdown: {
          controlScores: scoreResult.controlScores,
          deductions: scoreResult.deductions,
          reason: scoreResult.reason,
          ai03: input.ai03,
          triage: input.triage ?? null,
          detectorVersion,
          coverage: input.coverage,
          inputChecksum: scoreInputChecksum,
        },
        evidenceQuality: scoreResult.evidenceQuality,
        methodology: scoreResult.methodologyVersion,
        assessedCount: scoreResult.assessedCount,
        totalControls: scoreResult.totalControls,
        shareEligible: false,
        computedAt: now,
        // Score snapshots are immutable scan evidence. Advisory freshness affects
        // score availability at creation time, not historical retention.
        expiresAt: new Date("9999-12-31T23:59:59.999Z"),
      },
    })

    logger.info("AI security score snapshot created", {
      scanId,
      workspaceId,
      score: snapshot.score,
      assessedCount: snapshot.assessedCount,
    })

    return { snapshot, created: true }
  })
}

/** Returns a snapshot only if it belongs to the workspace. */
export async function getAiSecurityScoreSnapshot(scanId: string, workspaceId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    return tx.aiSecurityScoreSnapshot.findFirst({
      where: { scanId, workspaceId },
    })
  })
}

/** Returns the most recent non-expired AI security score for a target. */
export async function getLatestAiSecurityScoreSnapshot(targetId: string, workspaceId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    return tx.aiSecurityScoreSnapshot.findFirst({
      // Historical snapshots never expire. A current-posture selector may add
      // its own advisory freshness predicate without rewriting this evidence.
      where: { targetId, workspaceId },
      orderBy: { computedAt: "desc" },
    })
  })
}
