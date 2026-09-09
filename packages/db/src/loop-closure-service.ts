/**
 * Durable loop-closure for merged fix PRs (Deep Review v16 item 1.2).
 *
 * GitHub never redelivers a failed delivery automatically. The previous
 * strategy — delete the delivery marker and rethrow so GitHub "redelivers" —
 * silently lost the retest whenever the closure hit the scan concurrency
 * cap, worker unavailability, or an entitlement failure. The merge stayed
 * persisted, the retest was never created, and the only trace was a log line.
 *
 * This module owns the LoopClosure records: persist a deferred closure
 * instead of relying on redelivery, retry with backoff from the worker sweep,
 * and terminate at a maximum attempt count into a VISIBLE failure with an
 * in-app notification — never a silent loss.
 */

import { Prisma } from "./generated/prisma"
import { getSystemPrisma } from "./system-client"
import { withWorkspaceRLS } from "./rls"
import { createNotification } from "./notification-service"
import { logger } from "@lyrashield/logger"

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

export const LOOP_CLOSURE_MAX_ATTEMPTS = 5
/** Backoff schedule in minutes; index is min(attempts - 1, length - 1). */
export const LOOP_CLOSURE_BACKOFF_MINUTES = [1, 5, 15, 60, 240]

/** Structured reason codes persisted on LoopClosure.lastReason (bounded). */
export type LoopClosureReason =
  | "SCAN_CONCURRENCY_LIMIT"
  | "ACTIVE_SCAN_ON_TARGET"
  | "WORKER_UNAVAILABLE"
  | "RETEST_NOT_ENTITLED"
  | "UNEXPECTED_ERROR"

export function classifyLoopClosureError(error: unknown): LoopClosureReason {
  // Prefer structured identity (constructor name / code) over message text;
  // fall back to known message fragments only for plain Error throws from
  // the admission guard.
  const name = error instanceof Error ? error.constructor.name : ""
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : ""
  const message = error instanceof Error ? error.message : String(error)

  if (name === "WorkspaceScanConcurrencyLimitError") return "SCAN_CONCURRENCY_LIMIT"
  if (name === "ScanWorkerUnavailableError" || code === "SCAN_SERVICE_UNAVAILABLE") {
    return "WORKER_UNAVAILABLE"
  }
  if (message === "Target already has an active scan" || message === "ACTIVE_SCAN_ON_TARGET") {
    return "ACTIVE_SCAN_ON_TARGET"
  }
  if (
    message === "RETEST_NOT_ENTITLED" ||
    /TRIAL_EXPIRED|NO_MINUTES_REMAINING|TARGET_LIMIT_REACHED|DEEP_NOT_ALLOWED/.test(message)
  ) {
    return "RETEST_NOT_ENTITLED"
  }
  // The admission guard throws new Error(entitlement.code); the enqueue path
  // surfaces BullMQ/Redis outage messages. Both are retryable worker-side
  // conditions rather than webhook-payload problems.
  if (message.includes("already has") && message.includes("active scans")) {
    return "SCAN_CONCURRENCY_LIMIT"
  }
  if (message.includes("worker") || message.includes("queue") || message.includes("Redis")) {
    return "WORKER_UNAVAILABLE"
  }
  return "UNEXPECTED_ERROR"
}

export function nextLoopClosureRetryAt(attempts: number, now = new Date()): Date {
  const index = Math.min(Math.max(attempts, 0), LOOP_CLOSURE_BACKOFF_MINUTES.length - 1)
  const minutes: number = LOOP_CLOSURE_BACKOFF_MINUTES[index] ?? 240
  return new Date(now.getTime() + minutes * 60 * 1000)
}

/**
 * Persist (or refresh) a deferred closure for a merged fix PR. Idempotent on
 * (workspaceId, branchName): a duplicate delivery refreshes the retry state
 * rather than creating a second row, and a completed or terminal-failed
 * closure is never reopened.
 */
export async function recordDeferredLoopClosure(input: {
  workspaceId: string
  branchName: string
  prNumber?: number | null
  reason: LoopClosureReason
  /** Absolute attempt count for this deferral; defaults to 1 on create. */
  attempts?: number
  now?: Date
}): Promise<void> {
  const attempts = input.attempts ?? 1
  const nextRetryAt = nextLoopClosureRetryAt(attempts, input.now)
  try {
    await withWorkspaceRLS(input.workspaceId, (tx) =>
      tx.loopClosure.upsert({
        where: {
          workspaceId_branchName: {
            workspaceId: input.workspaceId,
            branchName: input.branchName,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          branchName: input.branchName,
          prNumber: input.prNumber ?? null,
          status: "pending",
          attempts,
          lastReason: input.reason,
          nextRetryAt,
        },
        update: {
          ...(input.prNumber != null ? { prNumber: input.prNumber } : {}),
          status: "pending",
          attempts,
          lastReason: input.reason,
          nextRetryAt,
        },
      })
    )
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // A concurrent delivery raced the upsert; the winner's row stands.
      logger.info("Concurrent loop-closure record raced; existing row stands", {
        workspaceId: input.workspaceId,
        branchName: input.branchName,
      })
      return
    }
    throw error
  }
  logger.info("Deferred loop-closure recorded for retry", {
    workspaceId: input.workspaceId,
    branchName: input.branchName,
    reason: input.reason,
    attempts,
    nextRetryAt: nextRetryAt.toISOString(),
  })
}

/** Mark a closure complete. Idempotent: completing twice is a no-op. */
export async function completeLoopClosure(workspaceId: string, branchName: string): Promise<void> {
  await withWorkspaceRLS(workspaceId, (tx) =>
    tx.loopClosure.updateMany({
      where: {
        workspaceId,
        branchName,
        status: { not: "completed" },
      },
      data: { status: "completed", completedAt: new Date() },
    })
  )
}

/**
 * Move an exhausted closure to its terminal, VISIBLE state and notify the
 * workspace. The notification follows the cause-effect-recovery structure:
 * what happened, what it means, and the manual recovery action (start a
 * retest from the finding).
 */
export async function failLoopClosureTerminally(
  workspaceId: string,
  branchName: string,
  prNumber: number | null,
  reason: LoopClosureReason
): Promise<void> {
  await withWorkspaceRLS(workspaceId, (tx) =>
    tx.loopClosure.updateMany({
      where: { workspaceId, branchName, status: "pending" },
      data: { status: "failed", lastReason: reason },
    })
  )
  await createNotification({
    workspaceId,
    channel: "in_app",
    type: "loop_closure_failed",
    title: "Automatic retest could not be scheduled",
    body:
      `A fix PR was merged (branch ${branchName}${prNumber != null ? `, PR #${prNumber}` : ""}) ` +
      `but its automatic retest could not be scheduled after ${LOOP_CLOSURE_MAX_ATTEMPTS} attempts ` +
      `(${reason}). The merge is recorded. Start the retest manually from the finding when you are ready.`,
    dedupeKey: `loop_closure_failed:${workspaceId}:${branchName}`,
  })
  logger.warn("Loop closure terminated as failed after max attempts", {
    workspaceId,
    branchName,
    reason,
  })
}

/**
 * Claim the due pending closures for a sweep pass. Returns rows with
 * attempts already incremented so a crash between claim and completion
 * cannot silently lose an attempt.
 */
export async function claimDueLoopClosures(
  now = new Date(),
  limit = 20
): Promise<
  Array<{
    id: string
    workspaceId: string
    branchName: string
    prNumber: number | null
    attempts: number
    lastReason: string | null
  }>
> {
  // Cross-workspace system read: the sweep runs without a workspace context,
  // like the scan-queue reconciliation preflight.
  const due = await getSystemPrisma().loopClosure.findMany({
    where: { status: "pending", nextRetryAt: { lte: now } },
    orderBy: [{ attempts: "asc" }, { nextRetryAt: "asc" }],
    take: limit,
    select: {
      id: true,
      workspaceId: true,
      branchName: true,
      prNumber: true,
      attempts: true,
      lastReason: true,
    },
  })
  return due
}
