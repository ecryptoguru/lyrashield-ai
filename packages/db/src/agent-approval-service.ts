import { prisma } from "./client"
import { withWorkspaceRLS } from "./rls"
import type { AgentApproval, ApprovalStatus } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import { createHash } from "node:crypto"
import { sortKeysReplacer } from "./agent-operation-hash"
import { isJsonObject } from "@lyrashield/types"

export interface CreateApprovalParams {
  workspaceId: string
  actionName: string
  input: Record<string, unknown>
  requestedById: string
  expiresAt?: Date
  /** Server-established credential authorization, never accepted from tool input. */
  authorization?: { kind: "oauth-connection" | "api-key"; id: string }
}

export interface ListApprovalsParams {
  workspaceId: string
  status?: ApprovalStatus
  cursor?: string
  limit?: number
}

export class ApprovalMutationError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED" | "INPUT_MISMATCH" | "UNSUPPORTED_INPUT",
    message: string
  ) {
    super(message)
    this.name = "ApprovalMutationError"
  }
}

function assertPersistableApprovalInput(input: Record<string, unknown>): void {
  const pending: unknown[] = [input]
  const seen = new WeakSet<object>()
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    if (Object.hasOwn(value, "__proto__")) {
      throw new ApprovalMutationError(
        "UNSUPPORTED_INPUT",
        "Approval input contains a key that cannot be stored safely"
      )
    }
    for (const nested of Object.values(value)) pending.push(nested)
  }
}

export async function createApproval(params: CreateApprovalParams): Promise<AgentApproval> {
  assertPersistableApprovalInput(params.input)
  const inputHash = hashInput(params.actionName, params.input)
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000)

  let approval = await prisma.agentApproval.create({
    data: {
      workspaceId: params.workspaceId,
      actionName: params.actionName,
      inputHash,
      input: params.input,
      requestedById: params.requestedById,
      expiresAt,
    },
  })

  if (params.authorization) {
    if (
      approval.actionName !== params.actionName ||
      approval.inputHash !== inputHash ||
      !isJsonObject(approval.input) ||
      !verifyInputHash(approval.actionName, approval.input, inputHash)
    ) {
      throw new ApprovalMutationError(
        "INPUT_MISMATCH",
        "Stored approval input changed; request a new approval"
      )
    }
    await prisma.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: params.requestedById,
        action: "agent_action.connection_authorized",
        resourceType: "agent_approval",
        resourceId: approval.id,
        metadata: { ...params.authorization, actionName: params.actionName, inputHash },
      },
    })
    approval = await approveStoredApproval(approval.id, params.workspaceId, null, inputHash)
  }

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

/** Serialize reuse of a pending human approval for the same workspace and input. */
export async function findOrCreatePendingApproval(
  params: Omit<CreateApprovalParams, "authorization">
): Promise<AgentApproval> {
  assertPersistableApprovalInput(params.input)
  const inputHash = hashInput(params.actionName, params.input)
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const lockKey = `pending-approval:${params.workspaceId}:${params.actionName}:${inputHash}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    const now = new Date()
    const existing = await tx.agentApproval.findFirst({
      where: {
        workspaceId: params.workspaceId,
        actionName: params.actionName,
        inputHash,
        status: "PENDING",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
    if (
      existing &&
      isJsonObject(existing.input) &&
      verifyInputHash(existing.actionName, existing.input, existing.inputHash)
    )
      return existing
    return tx.agentApproval.create({
      data: {
        workspaceId: params.workspaceId,
        actionName: params.actionName,
        inputHash,
        input: params.input,
        requestedById: params.requestedById,
        expiresAt: params.expiresAt ?? new Date(now.getTime() + 15 * 60 * 1000),
      },
    })
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
    ...(params.status === "PENDING"
      ? { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
      : {}),
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
  approvedById: string,
  expectedInputHash: string
): Promise<AgentApproval> {
  const result = await approveStoredApproval(
    approvalId,
    workspaceId,
    approvedById,
    expectedInputHash
  )
  logger.info("Agent approval approved", { approvalId, approvedById })
  return result
}

async function approveStoredApproval(
  approvalId: string,
  workspaceId: string,
  approvedById: string | null,
  expectedInputHash: string
): Promise<AgentApproval> {
  const result = await withWorkspaceRLS(workspaceId, async (tx) => {
    // Lock before reading: Prisma's JSON filter serialization can discard
    // special keys, so it cannot serve as an exact-input compare-and-swap.
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "public"."AgentApproval" WHERE "id" = ${approvalId} AND "workspaceId" = ${workspaceId} FOR UPDATE`
    if (locked.length !== 1 || locked[0]?.id !== approvalId) {
      return { error: new ApprovalMutationError("NOT_FOUND", "Approval not found") }
    }
    const approval = await tx.agentApproval.findFirst({ where: { id: approvalId, workspaceId } })
    if (!approval) return { error: new ApprovalMutationError("NOT_FOUND", "Approval not found") }
    if (approval.status !== "PENDING") {
      return { error: new ApprovalMutationError("NOT_PENDING", "Approval is not pending") }
    }
    const decidedAt = new Date()
    if (approval.expiresAt && approval.expiresAt <= decidedAt) {
      await tx.agentApproval.updateMany({
        where: { id: approvalId, workspaceId, status: "PENDING" },
        data: { status: "EXPIRED" },
      })
      return { error: new ApprovalMutationError("EXPIRED", "Approval has expired") }
    }
    // Old records can contain keys omitted by the former serializer.
    if (
      approval.inputHash !== expectedInputHash ||
      !isJsonObject(approval.input) ||
      !verifyInputHash(approval.actionName, approval.input, approval.inputHash)
    ) {
      return {
        error: new ApprovalMutationError(
          "INPUT_MISMATCH",
          "Stored approval input changed; request a new approval"
        ),
      }
    }
    const updated = await tx.agentApproval.updateMany({
      where: { id: approvalId, workspaceId, status: "PENDING", inputHash: expectedInputHash },
      data: { status: "APPROVED", approvedById, approvedAt: decidedAt },
    })
    if (updated.count !== 1) {
      return { error: new ApprovalMutationError("NOT_PENDING", "Approval was already decided") }
    }
    return {
      approval: { ...approval, status: "APPROVED" as const, approvedById, approvedAt: decidedAt },
    }
  })
  if (result.error) throw result.error
  return result.approval!
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
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "public"."AgentApproval" WHERE "id" = ${approvalId} AND "workspaceId" = ${workspaceId} FOR UPDATE`
    if (locked.length !== 1 || locked[0]?.id !== approvalId) return false
    const approval = await tx.agentApproval.findFirst({ where: { id: approvalId, workspaceId } })
    const now = new Date()
    if (
      !approval ||
      approval.status !== "APPROVED" ||
      approval.inputHash !== inputHash ||
      (approval.expiresAt !== null && approval.expiresAt <= now) ||
      !isJsonObject(approval.input) ||
      !verifyInputHash(approval.actionName, approval.input, inputHash)
    )
      return false
    const update = await tx.agentApproval.updateMany({
      where: {
        id: approvalId,
        workspaceId,
        status: "APPROVED",
        inputHash,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { status: "EXECUTING", attempts: { increment: 1 } },
    })
    return update.count === 1
  })
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

export function verifyInputHash(
  actionName: string,
  input: Record<string, unknown>,
  expectedHash: string
): boolean {
  return hashInput(actionName, input) === expectedHash
}
