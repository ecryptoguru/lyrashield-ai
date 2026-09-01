/**
 * Launch Gate service — adapts stored workspace evidence into the pure
 * @lyrashield/gate compute and persists the resulting immutable GateVerdict.
 *
 * Boundary rule (same as the score layer): packages/gate owns the versioned
 * verdict math; this service owns all database reads/writes. All reads go
 * through withWorkspaceRLS — never the system client.
 */

import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  requiredScannersForTarget,
  isTargetTypeCovered,
  type GateEvidenceInput,
  type GateVerdictResult,
} from "@lyrashield/gate"
import { logger } from "@lyrashield/logger"
import { withWorkspaceRLS } from "./rls"

export interface GateEvaluationResult {
  verdict: GateVerdictResult
  gateVerdictId: string
  /** Present when the gate could not evaluate at all (e.g. no completed scan). */
  note?: string
}

function toEpochMs(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null
}

/**
 * Evaluate the Launch Gate for a target and persist the verdict.
 *
 * Returns null when the workspace has no such target. Throws nothing on a
 * target with no completed scan — that is a valid INSUFFICIENT_EVIDENCE path,
 * not an error.
 */
export async function evaluateGateForTarget(
  workspaceId: string,
  targetId: string
): Promise<GateEvaluationResult | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const target = await tx.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true, type: true },
    })
    if (!target) return null

    const latestCompletedScan = await tx.scan.findFirst({
      where: { workspaceId, targetId, status: "COMPLETED", deletedAt: null },
      orderBy: { endedAt: "desc" },
      select: { id: true, endedAt: true, status: true },
    })

    const coverageReceipts = latestCompletedScan
      ? await tx.scanCoverageReceipt.findMany({
          where: { scanId: latestCompletedScan.id },
          select: { controlId: true, scanner: true, status: true, reason: true },
        })
      : []

    const findings = await tx.finding.findMany({
      where: { workspaceId, targetId, deletedAt: null },
      select: {
        id: true,
        severity: true,
        status: true,
        verificationStatus: true,
        verificationMethod: true,
        lastSeenAt: true,
      },
    })

    const evidence: GateEvidenceInput = {
      targetId,
      latestCompletedScan: latestCompletedScan
        ? {
            id: latestCompletedScan.id,
            endedAtMs: toEpochMs(latestCompletedScan.endedAt),
            status: latestCompletedScan.status,
          }
        : null,
      coverageReceipts: coverageReceipts.map((r) => ({
        controlId: r.controlId,
        scanner: r.scanner,
        status: r.status as GateEvidenceInput["coverageReceipts"][number]["status"],
        reason: r.reason,
      })),
      findings: findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        status: f.status,
        verificationStatus: f.verificationStatus,
        // Retest-confirmed resolution: a RETEST-method verification that reached
        // a resolved lifecycle state. The gate treats it as loop-closed.
        retestConfirmedResolved:
          f.verificationMethod === "RETEST" &&
          (f.status === "FIXED" || f.status === "FALSE_POSITIVE" || f.status === "ACCEPTED_RISK"),
        lastSeenAtMs: f.lastSeenAt.getTime(),
      })),
      requiredScanners: isTargetTypeCovered(target.type)
        ? requiredScannersForTarget(target.type)
        : [],
    }

    const verdict = computeGateVerdict(evidence)
    const inputChecksum = computeInputChecksum(evidence)
    const verdictChecksum = computeVerdictChecksum(verdict)

    const record = await tx.gateVerdict.create({
      data: {
        workspaceId,
        targetId,
        scanId: latestCompletedScan?.id ?? null,
        standardVersion: verdict.standardVersion,
        state: verdict.state,
        coverageStatement: verdict.coverageStatement,
        nonCoverage: verdict.nonCoverage,
        blockingReasons: verdict.blockingReasons,
        evidenceSummary: verdict.evidenceSummary,
        staleness: verdict.staleness,
        inputChecksum,
        verdictChecksum,
      },
      select: { id: true },
    })

    return { verdict, gateVerdictId: record.id }
  })
}

/**
 * Read the latest verdict for a target without recomputing. Returns null when
 * no verdict has been recorded yet.
 */
export async function getLatestGateVerdict(workspaceId: string, targetId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    return tx.gateVerdict.findFirst({
      where: { workspaceId, targetId },
      orderBy: { evaluatedAt: "desc" },
    })
  })
}

/**
 * WP3 loop-closure orchestration: mark a merged fix PR, queue a retest on the
 * finding's latest completed scan, then re-evaluate the gate for the target.
 * Kept in the db package so the GitHub webhook route stays a thin adapter.
 * Returns null (a no-op) when the branch matches no open fix PR in this
 * workspace.
 */
export async function handleFixPrMergedAndReevaluate(
  workspaceId: string,
  branchName: string,
  prNumber?: number
): Promise<import("./fix-proposal-service").FixPrMergeResult | null> {
  const { handleFixPrMerged } = await import("./fix-proposal-service")

  // Resolve the finding's latest completed scan to anchor the retest, and the
  // target for gate re-evaluation — both under RLS.
  const anchor = await withWorkspaceRLS(workspaceId, async (tx) => {
    const pr = await tx.pullRequest.findFirst({
      where: {
        branchName,
        status: "open",
        deletedAt: null,
        fixProposal: { finding: { workspaceId, deletedAt: null } },
      },
      select: {
        fixProposal: {
          select: {
            finding: {
              select: {
                targetId: true,
                scan: { select: { id: true } },
              },
            },
          },
        },
      },
    })
    if (!pr?.fixProposal?.finding?.targetId || !pr.fixProposal.finding.scan?.id) return null
    return {
      targetId: pr.fixProposal.finding.targetId,
      scanId: pr.fixProposal.finding.scan.id,
    }
  })
  if (!anchor) return null

  const result = await handleFixPrMerged({
    workspaceId,
    branchName,
    prNumber,
    retestScanId: anchor.scanId,
  })
  if (!result) return null

  // Re-evaluate the gate so a merged fix moves the verdict. Best-effort: a gate
  // failure must not roll back the merge/retest that already committed.
  await evaluateGateForTarget(workspaceId, anchor.targetId).catch((error) => {
    logger.warn("Gate re-evaluation after fix PR merge failed (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  return result
}
