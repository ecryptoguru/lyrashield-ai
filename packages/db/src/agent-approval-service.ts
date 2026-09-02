import { prisma } from "./client"
import type { AgentApproval, ApprovalStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { createHash } from "node:crypto"

export interface CreateApprovalParams {
  workspaceId: string
  actionName: string
  input: Record<string, unknown>
  requestedById: string
  expiresAt?: Date
}

export interface ListApprovalsParams {
  workspaceId: string
  status?: ApprovalStatus
  cursor?: string
  limit?: number
}

export class ApprovalMutationError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED",
    message: string
  ) {
    super(message)
    this.name = "ApprovalMutationError"
  }
}

export async function createApproval(params: CreateApprovalParams): Promise<AgentApproval> {
  const inputHash = hashInput(params.actionName, params.input)
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000)

  const approval = await prisma.agentApproval.create({
    data: {
      workspaceId: params.workspaceId,
      actionName: params.actionName,
      inputHash,
      input: params.input,
      requestedById: params.requestedById,
      expiresAt,
    },
  })

  logger.info("Agent approval created", {
    approvalId: approval.id,
    workspaceId: params.workspaceId,
    actionName: params.actionName,
  })

  return approval
}

export async function getApproval(
  approvalId: string,
  workspaceId: string
): Promise<AgentApproval | null> {
  return prisma.agentApproval.findFirst({
    where: { id: approvalId, workspaceId },
  })
}

export async function findPendingApprovalByHash(
  workspaceId: string,
  actionName: string,
  inputHash: string
): Promise<AgentApproval | null> {
  return prisma.agentApproval.findFirst({
    where: { workspaceId, actionName, inputHash, status: "PENDING" },
  })
}

/** Atomically mark an APPROVED approval as EXECUTED and persist its result. */
export async function executeApproval(
  approvalId: string,
  workspaceId: string,
  result: Record<string, unknown>
): Promise<boolean> {
  const update = await prisma.agentApproval.updateMany({
    where: { id: approvalId, workspaceId, status: "APPROVED" },
    data: { status: "EXECUTED", executedAt: new Date(), result },
  })
  return update.count === 1
}

export type ApprovalListItem = Omit<AgentApproval, "result">

export async function listApprovals(params: ListApprovalsParams): Promise<{
  items: ApprovalListItem[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const where: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    ...(params.status ? { status: params.status } : {}),
  }

  const approvals = await prisma.agentApproval.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      workspaceId: true,
      actionName: true,
      inputHash: true,
      status: true,
      attempts: true,
      input: true,
      requestedById: true,
      approvedById: true,
      approvedAt: true,
      deniedAt: true,
      executedAt: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  const hasMore = approvals.length > limit
  const items = hasMore ? approvals.slice(0, limit) : approvals
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

  return { items, nextCursor }
}

export async function approveApproval(
  approvalId: string,
  workspaceId: string,
  approvedById: string
): Promise<AgentApproval> {
  const approval = await prisma.agentApproval.findFirst({
    where: { id: approvalId, workspaceId },
  })
  if (!approval) throw new ApprovalMutationError("NOT_FOUND", `Approval not found: ${approvalId}`)

  if (approval.status !== "PENDING") {
    throw new ApprovalMutationError(
      "NOT_PENDING",
      `Approval is not pending (current: ${approval.status})`
    )
  }

  if (approval.expiresAt && approval.expiresAt < new Date()) {
    await prisma.agentApproval.updateMany({
      where: { id: approvalId, workspaceId, status: "PENDING" },
      data: { status: "EXPIRED" },
    })
    throw new ApprovalMutationError("EXPIRED", "Approval has expired")
  }

  const decidedAt = new Date()
  const updated = await prisma.agentApproval.updateMany({
    where: {
      id: approvalId,
      workspaceId,
      status: "PENDING",
      OR: [{ expiresAt: null }, { expiresAt: { gt: decidedAt } }],
    },
    data: {
      status: "APPROVED",
      approvedById,
      approvedAt: decidedAt,
    },
  })
  if (updated.count !== 1)
    throw new ApprovalMutationError("NOT_PENDING", "Approval was already decided or expired")

  logger.info("Agent approval approved", { approvalId, approvedById })
  return { ...approval, status: "APPROVED", approvedById, approvedAt: decidedAt }
}

export async function denyApproval(
  approvalId: string,
  workspaceId: string,
  deniedById: string
): Promise<AgentApproval> {
  const approval = await prisma.agentApproval.findFirst({
    where: { id: approvalId, workspaceId },
  })
  if (!approval) throw new ApprovalMutationError("NOT_FOUND", `Approval not found: ${approvalId}`)

  if (approval.status !== "PENDING") {
    throw new ApprovalMutationError(
      "NOT_PENDING",
      `Approval is not pending (current: ${approval.status})`
    )
  }

  // approvedById stores the user who made the decision (approve or deny)
  // for audit purposes. deniedAt timestamp distinguishes deny from approve.
  const deniedAt = new Date()
  const updated = await prisma.agentApproval.updateMany({
    where: { id: approvalId, workspaceId, status: "PENDING" },
    data: {
      status: "DENIED",
      approvedById: deniedById,
      deniedAt,
    },
  })
  if (updated.count !== 1)
    throw new ApprovalMutationError("NOT_PENDING", "Approval was already decided")

  logger.info("Agent approval denied", { approvalId, deniedById })
  return { ...approval, status: "DENIED", approvedById: deniedById, deniedAt }
}

export async function saveApprovalResult(
  approvalId: string,
  workspaceId: string,
  result: Record<string, unknown>
): Promise<void> {
  await prisma.agentApproval.update({
    where: { id: approvalId, workspaceId },
    data: { result },
  })
}

/** Atomically spends an approved authorization; a consumed approval can never be replayed. */
export async function consumeApproval(approvalId: string, workspaceId: string): Promise<boolean> {
  const result = await prisma.agentApproval.updateMany({
    where: { id: approvalId, workspaceId, status: "APPROVED" },
    data: { status: "EXECUTED", executedAt: new Date() },
  })
  return result.count === 1
}

/** Maximum execution attempts before an approval becomes terminally EXECUTION_FAILED. */
export const MAX_APPROVAL_EXECUTION_ATTEMPTS = 3

/**
 * Atomically claim an APPROVED approval for execution. Exactly one concurrent
 * caller wins (count === 1) and may run side effects; every other caller loses.
 * Hash and expiry are enforced inside the claim predicate so a raced or
 * mismatched request can never transition the row.
 */
export async function claimApprovalExecution(
  approvalId: string,
  workspaceId: string,
  inputHash: string
): Promise<boolean> {
  const update = await prisma.agentApproval.updateMany({
    where: {
      id: approvalId,
      workspaceId,
      status: "APPROVED",
      inputHash,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    data: { status: "EXECUTING", attempts: { increment: 1 } },
  })
  return update.count === 1
}

/**
 * Compare-and-set completion: only the EXECUTING owner transitions to EXECUTED
 * and stores its result. Losers can never overwrite the winner's result.
 */
export async function completeApprovalExecution(
  approvalId: string,
  workspaceId: string,
  result: Record<string, unknown>
): Promise<boolean> {
  const update = await prisma.agentApproval.updateMany({
    where: { id: approvalId, workspaceId, status: "EXECUTING" },
    data: { status: "EXECUTED", executedAt: new Date(), result },
  })
  return update.count === 1
}

/**
 * Settle a failed execution. While the attempt budget lasts, the row returns
 * to APPROVED so the next poll retries; past the budget it becomes terminally
 * EXECUTION_FAILED with the stored error result (replay-safe, never re-runs).
 */
export async function failApprovalExecution(
  approvalId: string,
  workspaceId: string,
  errorResult?: Record<string, unknown>,
  retryable = true
): Promise<"RETRYABLE" | "TERMINAL"> {
  const released = retryable
    ? await prisma.agentApproval.updateMany({
        where: {
          id: approvalId,
          workspaceId,
          status: "EXECUTING",
          attempts: { lt: MAX_APPROVAL_EXECUTION_ATTEMPTS },
        },
        data: { status: "APPROVED" },
      })
    : { count: 0 }
  if (released.count === 1) return "RETRYABLE"

  await prisma.agentApproval.updateMany({
    where: { id: approvalId, workspaceId, status: "EXECUTING" },
    data: { status: "EXECUTION_FAILED", ...(errorResult ? { result: errorResult } : {}) },
  })
  logger.warn("Agent approval execution failed terminally", { approvalId, workspaceId })
  return "TERMINAL"
}

/**
 * Expire stale approvals whose TTL has passed. Covers both never-approved
 * PENDING rows and APPROVED rows nobody executed; EXECUTING rows are
 * mid-flight claims and are deliberately left alone.
 */
export async function expireStaleApprovals(workspaceId?: string): Promise<number> {
  const result = await prisma.agentApproval.updateMany({
    where: {
      status: { in: ["PENDING", "APPROVED"] },
      expiresAt: { lt: new Date() },
      ...(workspaceId ? { workspaceId } : {}),
    },
    data: { status: "EXPIRED" },
  })

  if (result.count > 0) {
    logger.info("Expired stale agent approvals", { count: result.count, workspaceId })
  }

  return result.count
}

export function hashInput(actionName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ actionName, input }, sortKeysReplacer)
  return createHash("sha256").update(canonical).digest("hex")
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k]
    }
    return sorted
  }
  return value
}

export function verifyInputHash(
  actionName: string,
  input: Record<string, unknown>,
  expectedHash: string
): boolean {
  return hashInput(actionName, input) === expectedHash
}
