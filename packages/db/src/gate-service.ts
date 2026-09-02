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
import {
  resolveRetestProfile,
  resolveTargetScanMode,
  type ScanGoal,
  type ScanMode,
} from "@lyrashield/types"
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
      targetTypeCovered: isTargetTypeCovered(target.type),
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
      // id tiebreaker: evaluatedAt is a timestamp — two verdicts in the same
      // millisecond are possible (e.g. merge + completion in one tick), and
      // ordering by timestamp alone would make the "latest" nondeterministic.
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
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
  prNumber: number | undefined,
  assertRetestAllowed: (mode: ScanMode) => Promise<void>
): Promise<FixPrMergeOutcome | null> {
  if (typeof assertRetestAllowed !== "function") throw new Error("Retest admission guard required")
  return withWorkspaceRLS(
    workspaceId,
    async (lockTx) => {
      // Serialize redeliveries through scan creation and durable retest association.
      await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fix-loop:${workspaceId}:${branchName}`}, 0))`
      const { handleFixPrMerged } = await import("./fix-proposal-service")

      // Resolve the finding's target and its latest COMPLETED scan (the retest
      // template) — both under RLS.
      const anchor = await withWorkspaceRLS(workspaceId, async (tx) => {
        const pr = await tx.pullRequest.findFirst({
          where: {
            branchName,
            status: { in: ["open", "merged"] },
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
          sourceScanId: finding.scan.id,
          sourceMode: finding.scan.mode,
          targetId: template.targetId,
          // Prisma returns the enum values as strings; the asserted type carries
          // the canonical union names so consumers satisfy ScanJobData directly.
          template: {
            ...template,
            targetId: template.targetId,
          } as {
            id: string
            goal: ScanGoal
            mode: ScanMode
            policyId: string | null
            targetId: string
          },
        }
      })
      if (!anchor) return null

      // Persist merge state first. The merge helper also resolves already-merged
      // rows so a retry can resume the missing retest or queue delivery.
      const result = await handleFixPrMerged({
        workspaceId,
        branchName,
        prNumber,
      })
      if (!result) return null

      const marker = `Automatic fix PR retest: ${result.pullRequestId}`
      const prior = await lockTx.retest.findFirst({
        where: { workspaceId, findingId: anchor.findingId, resultBefore: marker },
        include: { scan: true },
        orderBy: { createdAt: "desc" },
      })
      if (prior) {
        // A queue failure leaves the same durable scan available for redelivery.
        if (prior.scan.status !== "QUEUED") return null
        await assertRetestAllowed(prior.scan.mode)
        return {
          ...result,
          retestId: prior.id,
          retestScanId: prior.scanId,
          targetId: anchor.targetId,
          goal: prior.scan.goal,
          mode: prior.scan.mode,
          policyId: prior.scan.policyId,
        }
      }
      const pending = await lockTx.retest.findFirst({
        where: { workspaceId, findingId: anchor.findingId, status: { in: ["pending", "running"] } },
      })
      if (pending) return null
      const target = await lockTx.target.findFirst({
        where: { workspaceId, id: anchor.targetId, deletedAt: null },
        select: { type: true, apiSpecUrl: true },
      })
      if (!target) return null
      const candidates = await lockTx.findingCandidate.findMany({
        where: { workspaceId, findingId: anchor.findingId, scanId: anchor.sourceScanId },
        select: { scannerSource: true },
      })
      const profile = resolveRetestProfile(
        anchor.sourceMode,
        candidates.map((c) => c.scannerSource)
      )
      const resolved = resolveTargetScanMode({
        targetType: target.type,
        mode: profile.mode as ScanMode,
        hasApiSpec: Boolean(target.apiSpecUrl),
      })
      if (!resolved.ok) throw new Error(resolved.reason)
      await assertRetestAllowed(profile.mode as ScanMode)

      // Create the REAL retest scan + Retest row bound to it. This mirrors the
      // user retest route (api/findings/[id]/retests): createScan with
      // triggerType "retest", Retest.scanId = the NEW scan id. The Retest stays
      // pending until the new scan completes, when completeRetestsForScan binds
      // its verdict to the stored baseline/retest checksums.
      const { createScan, updateScanStatus, WorkspaceScanConcurrencyLimitError } =
        await import("./scan-service")
      let retestScanId: string | undefined
      let retestId: string
      try {
        const retestScan = await createScan({
          workspaceId,
          targetId: anchor.template.targetId,
          goal: anchor.template.goal,
          mode: profile.mode as ScanMode,
          determinismMode: profile.determinismMode,
          policyId: anchor.template.policyId ?? undefined,
          createdById: result.actedById,
          triggerType: "retest",
        })
        retestScanId = retestScan.id
        const retest = await lockTx.retest.create({
          data: {
            workspaceId,
            findingId: anchor.findingId,
            scanId: retestScanId,
            status: "pending",
            resultBefore: marker,
          },
        })
        retestId = retest.id
      } catch (retestError) {
        if (retestScanId)
          await updateScanStatus(retestScanId, "FAILED", {
            errorCategory: "RETEST_SETUP",
            errorMessage: "Automatic retest setup failed before queueing",
          })
        if (
          retestError instanceof WorkspaceScanConcurrencyLimitError ||
          (retestError instanceof Error &&
            retestError.message === "Target already has an active scan")
        ) {
          logger.info("Automatic retest deferred until scan capacity is available", {
            workspaceId,
            branchName,
          })
          throw retestError
        }
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
        retestId,
        retestScanId,
        targetId: anchor.template.targetId,
        goal: anchor.template.goal,
        mode: profile.mode as ScanMode,
        policyId: anchor.template.policyId,
      }
    },
    { timeout: 30_000 }
  )
}

/** handleFixPrMergedAndReevaluate result: the merge outcome plus the retest scan to enqueue. */
export interface FixPrMergeOutcome extends FixPrMergeResult {
  /** The newly created retest scan the CALLER must enqueue. */
  retestScanId: string
  /** The template the retest scan was created from — the fields the caller's enqueue payload needs. */
  targetId: string
  /** Scan goal/mode as the canonical union names so the webhook enqueue
   * payload satisfies ScanJobData directly. */
  goal: ScanGoal
  mode: ScanMode
  policyId: string | null
}
