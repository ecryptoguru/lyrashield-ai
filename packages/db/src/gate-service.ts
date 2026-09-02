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
import type { FixPrMergeResult } from "./fix-proposal-service"
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
 * WP3 loop-closure orchestration: mark a merged fix PR, then queue a REAL
 * retest — a new scan of the finding's target that the retest binds to — and
 * re-evaluate the gate after that retest completes.
 *
 * The retest anchoring matters: `completeRetestsForScan` matches
 * `Retest.scanId` against the scan being completed, so a Retest stamped with
 * the finding's ORIGINAL (terminal) scan would never complete — it would sit
 * pending forever. This function therefore resolves the latest completed
 * scan, creates a fresh retest scan from it, and binds the Retest to the NEW
 * scan. The caller (the GitHub webhook route) enqueues the new scan —
 * packages/db cannot import the queue package without a dependency cycle.
 *
 * Returns null (a no-op) when the branch matches no open fix PR in this
 * workspace.
 */
export async function handleFixPrMergedAndReevaluate(
  workspaceId: string,
  branchName: string,
  prNumber?: number
): Promise<FixPrMergeOutcome | null> {
  const { handleFixPrMerged } = await import("./fix-proposal-service")

  // Resolve the finding's target and its latest COMPLETED scan (the retest
  // template) — both under RLS.
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
                id: true,
                targetId: true,
                scan: {
                  select: { id: true, goal: true, mode: true, policyId: true, targetId: true },
                },
              },
            },
          },
        },
      },
    })
    const finding = pr?.fixProposal?.finding
    if (!finding?.targetId || !finding.scan) return null

    // The latest COMPLETED scan for the target is the retest template — the
    // source scan whose evidence the retest compares against. Fall back to the
    // finding's own source scan when no completed scan exists.
    const latestCompleted = await tx.scan.findFirst({
      where: { workspaceId, targetId: finding.targetId, status: "COMPLETED", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, goal: true, mode: true, policyId: true, targetId: true },
    })
    const template = latestCompleted ?? finding.scan
    // Scan.targetId is nullable in the schema; a scan row without a target
    // cannot anchor a retest. (Finding.targetId is already null-checked above.)
    if (!template.targetId) return null
    return {
      findingId: finding.id,
      targetId: template.targetId,
      template: {
        ...template,
        targetId: template.targetId,
      } as {
        id: string
        goal: string
        mode: string
        policyId: string | null
        targetId: string
      },
    }
  })
  if (!anchor) return null

  // Mark the PR merged FIRST (idempotent via the open-status predicate in
  // handleFixPrMerged): a retest-creation failure must not leave the PR
  // reopenable, and a retried webhook redelivery will find no open PR and
  // no-op cleanly.
  const result = await handleFixPrMerged({
    workspaceId,
    branchName,
    prNumber,
  })
  if (!result) return null

  // Create the REAL retest scan + Retest row bound to it. This mirrors the
  // user retest route (api/findings/[id]/retests): createScan with
  // triggerType "retest", Retest.scanId = the NEW scan id. The Retest stays
  // pending until the new scan completes, when completeRetestsForScan binds
  // its verdict to the stored baseline/retest checksums.
  const { createScan } = await import("./scan-service")
  let retestScanId: string
  try {
    const retestScan = await createScan({
      workspaceId,
      targetId: anchor.template.targetId,
      goal: anchor.template.goal,
      mode: anchor.template.mode ?? undefined,
      policyId: anchor.template.policyId ?? undefined,
      createdById: result.actedById,
      triggerType: "retest",
    })
    retestScanId = retestScan.id
    await withWorkspaceRLS(workspaceId, (tx) =>
      tx.retest.create({
        data: {
          workspaceId,
          findingId: anchor.findingId,
          scanId: retestScanId,
          status: "pending",
          resultBefore: "Retest queued automatically after the fix PR merged.",
        },
      })
    )
  } catch (retestError) {
    // The merge is already committed. A retest-creation failure is best-effort
    // — the finding can still be retested manually from the dashboard — but
    // re-throw so the webhook route can delete its delivery marker and let
    // GitHub redeliver (the merge step above will no-op on redelivery).
    logger.error("Failed to create loop-closure retest scan", {
      workspaceId,
      branchName,
      error: retestError instanceof Error ? retestError.message : String(retestError),
    })
    throw retestError
  }

  // Re-evaluate the gate immediately against the merged state. This reflects
  // the PR merge (the fix exists on the target branch) even before the retest
  // confirms resolution; the retest's own completion path re-evaluates again
  // with confirmed evidence. Best-effort: a gate failure must not roll back
  // the merge/retest that already committed.
  await evaluateGateForTarget(workspaceId, anchor.targetId).catch((error) => {
    logger.warn("Gate re-evaluation after fix PR merge failed (non-fatal)", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  return {
    ...result,
    retestScanId,
    targetId: anchor.template.targetId,
    goal: anchor.template.goal,
    mode: anchor.template.mode,
    policyId: anchor.template.policyId,
  }
}

/** handleFixPrMergedAndReevaluate result: the merge outcome plus the retest scan to enqueue. */
export interface FixPrMergeOutcome extends FixPrMergeResult {
  /** The newly created retest scan the CALLER must enqueue. */
  retestScanId: string
  /** The template the retest scan was created from — the fields the caller's enqueue payload needs. */
  targetId: string
  goal: string
  mode: string
  policyId: string | null
}
