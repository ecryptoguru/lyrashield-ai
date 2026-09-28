import { logger } from "@lyrashield/logger"
import {
  resolveRetestProfile,
  resolveTargetScanMode,
  type ScanGoal,
  type ScanMode,
} from "@lyrashield/types"
import type { FixPrMergeResult } from "./fix-proposal-service"
import { evaluateGateForTarget } from "./gate-evaluation-service"
import { bindAccountRLSContext, withWorkspaceRLS, type ScopedTransaction } from "./rls"

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
 * Returns null (a no-op) when the branch matches no open or merged fix PR in this
 * workspace.
 */
export async function handleFixPrMergedAndReevaluate(
  workspaceId: string,
  branchName: string,
  prNumber: number | undefined,
  assertRetestAllowed: (
    mode: ScanMode,
    sponsorAccountId: string,
    tx: ScopedTransaction
  ) => Promise<void>,
  repoFullName?: string
): Promise<FixPrMergeOutcome | null> {
  if (typeof assertRetestAllowed !== "function") throw new Error("Retest admission guard required")
  const [repoOwner, repoName, ...extra] = repoFullName?.split("/") ?? []
  if (repoFullName && (!repoOwner || !repoName || extra.length > 0)) {
    throw new Error("Invalid GitHub repository identity")
  }
  const advisoryKey = `fix-loop:${workspaceId}:${branchName}`
  const findAnchor = async (tx: ScopedTransaction) => {
    const pr = await tx.pullRequest.findFirst({
      where: {
        branchName,
        ...(repoOwner && repoName ? { repoOwner, repoName } : {}),
        ...(prNumber ? { OR: [{ prNumber }, { prNumber: null }] } : {}),
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

    const latestCompleted = await tx.scan.findFirst({
      where: { workspaceId, targetId: finding.targetId, status: "COMPLETED", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, goal: true, mode: true, policyId: true, targetId: true },
    })
    const template = latestCompleted ?? finding.scan
    if (!template.targetId) return null
    const retestTemplate: {
      id: string
      goal: ScanGoal
      mode: ScanMode
      policyId: string | null
      targetId: string
    } = { ...template, targetId: template.targetId }
    return {
      findingId: finding.id,
      sourceScanId: finding.scan.id,
      sourceMode: finding.scan.mode,
      targetId: template.targetId,
      template: retestTemplate,
    }
  }

  const { handleFixPrMerged } = await import("./fix-proposal-service")
  // This helper commits merge state separately so failed retest creation can
  // resume on redelivery. It takes the same advisory lock in its transaction.
  const result = await handleFixPrMerged({ workspaceId, branchName, prNumber, repoFullName })
  if (!result) return null

  const outcome = await withWorkspaceRLS(
    workspaceId,
    async (lockTx) => {
      // Serialize redeliveries through scan creation and durable retest association.
      await lockTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))`
      const anchor = await findAnchor(lockTx)
      if (!anchor) return null

      // The retest's sponsoring account is the recorded actor — bind the
      // account RLS context inside this transaction so the entitlement check
      // sees the sponsor's ledger rows across workspaces.
      await bindAccountRLSContext(lockTx, result.actedById)

      const marker = `Automatic fix PR retest: ${result.pullRequestId}`
      const prior = await lockTx.retest.findFirst({
        where: { workspaceId, findingId: anchor.findingId, resultBefore: marker },
        include: { scan: true },
        orderBy: { createdAt: "desc" },
      })
      if (prior) {
        // A queue failure leaves the same durable scan available for redelivery.
        if (prior.scan.status !== "QUEUED") return null
        await assertRetestAllowed(prior.scan.mode, result.actedById, lockTx)
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
      await assertRetestAllowed(profile.mode as ScanMode, result.actedById, lockTx)

      // Create the REAL retest scan + Retest row bound to it. This mirrors the
      // user retest route (api/findings/[id]/retests): createScan with
      // triggerType "retest", Retest.scanId = the NEW scan id. The Retest stays
      // pending until the new scan completes, when completeRetestsForScan binds
      // its verdict to the stored baseline/retest checksums.
      const { createScan, WorkspaceScanConcurrencyLimitError } = await import("./scan-service")
      let retestScanId: string | undefined
      let retestId: string
      try {
        const retestScan = await createScan(
          {
            workspaceId,
            targetId: anchor.template.targetId,
            goal: anchor.template.goal,
            mode: profile.mode as ScanMode,
            determinismMode: profile.determinismMode,
            policyId: anchor.template.policyId ?? undefined,
            createdById: result.actedById,
            triggerType: "retest",
          },
          lockTx
        )
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
        // Scan and Retest share the transaction: any failure rolls both back.
        // Redelivery can resume from the separately persisted merge state.
        logger.error("Failed to create loop-closure retest scan", {
          workspaceId,
          branchName,
          error: retestError instanceof Error ? retestError.message : String(retestError),
        })
        throw retestError
      }

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
  // Gate evaluation cannot hold open or roll back the scan/association commit.
  if (outcome)
    await evaluateGateForTarget(workspaceId, outcome.targetId).catch((error) => {
      logger.warn("Gate re-evaluation after fix PR merge failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  return outcome
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
