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
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)

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

export async function listApprovals(params: ListApprovalsParams): Promise<{
  items: AgentApproval[]
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
    await prisma.agentApproval.update({
      where: { id: approvalId },
      data: { status: "EXPIRED" },
    })
    throw new ApprovalMutationError("EXPIRED", "Approval has expired")
  }

  const updated = await prisma.agentApproval.update({
    where: { id: approvalId },
    data: {
      status: "APPROVED",
      approvedById,
      approvedAt: new Date(),
    },
  })

  logger.info("Agent approval approved", { approvalId, approvedById })
  return updated
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
  const updated = await prisma.agentApproval.update({
    where: { id: approvalId },
    data: {
      status: "DENIED",
      approvedById: deniedById,
      deniedAt: new Date(),
    },
  })

  logger.info("Agent approval denied", { approvalId, deniedById })
  return updated
}

export async function saveApprovalResult(
  approvalId: string,
  result: Record<string, unknown>
): Promise<void> {
  await prisma.agentApproval.update({
    where: { id: approvalId },
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

export async function expireStaleApprovals(workspaceId?: string): Promise<number> {
  const result = await prisma.agentApproval.updateMany({
    where: {
      status: "PENDING",
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
