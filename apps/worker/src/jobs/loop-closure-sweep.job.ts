/**
 * Loop-closure sweep.
 *
 * Retries deferred fix-PR loop closures (merged PRs whose automatic retest
 * could not be created at webhook time) with backoff and a maximum attempt
 * count. A closure that exhausts its attempts terminates into a VISIBLE
 * failure — a persisted FAILED state plus an in-app notification with the
 * manual recovery action — never a silent loss. Nothing here ever merges or
 * auto-approves anything: the only side effects are the retest scan the
 * webhook path would have created, its queue entry, and the closure record.
 */

import { logger } from "@lyrashield/logger"
import {
  claimDueLoopClosures,
  recordDeferredLoopClosure,
  failLoopClosureTerminally,
  handleFixPrMergedAndReevaluate,
  classifyLoopClosureError,
  completeLoopClosure,
  LOOP_CLOSURE_MAX_ATTEMPTS,
  type LoopClosureReason,
} from "@lyrashield/db"
import { enqueueScan, assertScanWorkerAvailable } from "@lyrashield/integrations"
import { assertScanAllowed } from "@lyrashield/billing"

export interface LoopClosureSweepResult {
  claimed: number
  completed: number
  deferred: number
  failedTerminal: number
}

/**
 * One sweep pass over due pending closures. Bounded: at most `limit` closures
 * per pass so a large backlog cannot stall the timer tick.
 */
export async function processLoopClosureSweep(
  options: { limit?: number; now?: Date } = {}
): Promise<LoopClosureSweepResult> {
  const due = await claimDueLoopClosures(options.now ?? new Date(), options.limit ?? 20)
  const result: LoopClosureSweepResult = {
    claimed: due.length,
    completed: 0,
    deferred: 0,
    failedTerminal: 0,
  }
  if (due.length === 0) return result

  for (const closure of due) {
    try {
      const outcome = await handleFixPrMergedAndReevaluate(
        closure.workspaceId,
        closure.branchName,
        closure.prNumber,
        async (mode, sponsorAccountId, tx) => {
          const entitlement = await assertScanAllowed(
            closure.workspaceId,
            mode,
            sponsorAccountId,
            tx
          )
          if (!entitlement.allowed) throw new Error(entitlement.code ?? "RETEST_NOT_ENTITLED")
          await assertScanWorkerAvailable()
        },
        closure.repoFullName
      )
      if (outcome) {
        await enqueueScan({
          scanId: outcome.retestScanId,
          workspaceId: closure.workspaceId,
          targetId: outcome.targetId,
          goal: outcome.goal,
          mode: outcome.mode,
          ...(outcome.policyId ? { policyId: outcome.policyId } : {}),
        })
        await completeLoopClosure(closure.workspaceId, closure.repoFullName, closure.prNumber)
        result.completed++
        logger.info("Loop-closure sweep completed a deferred retest", {
          workspaceId: closure.workspaceId,
          branchName: closure.branchName,
          retestScanId: outcome.retestScanId,
          attempts: closure.attempts,
        })
      } else {
        // No actionable outcome: the PR is no longer associated with a live
        // finding (deleted target, resolved finding) or the retest already
        // exists. The closure is complete by definition.
        await completeLoopClosure(closure.workspaceId, closure.repoFullName, closure.prNumber)
        result.completed++
      }
    } catch (error) {
      const reason = classifyLoopClosureError(error)
      const attempts = closure.attempts
      try {
        if (attempts >= LOOP_CLOSURE_MAX_ATTEMPTS) {
          await failLoopClosureTerminally(
            closure.workspaceId,
            closure.repoFullName,
            closure.branchName,
            closure.prNumber,
            reason
          )
          result.failedTerminal++
        } else {
          await recordDeferredLoopClosure({
            workspaceId: closure.workspaceId,
            repoFullName: closure.repoFullName,
            branchName: closure.branchName,
            prNumber: closure.prNumber,
            reason: reason as LoopClosureReason,
            attempts,
          })
          result.deferred++
        }
      } catch (persistError) {
        logger.error("Loop-closure sweep could not persist retry state", {
          workspaceId: closure.workspaceId,
          branchName: closure.branchName,
          error: String(persistError),
        })
      }
    }
  }
  return result
}
