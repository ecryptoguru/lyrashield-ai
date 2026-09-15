/**
 * Confirmation engine — the MyraOperation ledger.
 *
 * Lifecycle: createProposal writes AWAITING_CONFIRMATION with the SHA-256
 * input hash of the exact payload, an idempotency key and a 15-minute
 * expiry. confirm() re-verifies ownership, state, expiry, conversation
 * takeover and the input hash before running the executor. An executor that
 * throws after a provider submission raises OutcomeUnknownError →
 * OUTCOME_UNKNOWN — reconciled later, never auto-retried.
 *
 * Owner-scoped DB phases run inside the principal's RLS binding; the
 * executor runs OUTSIDE that transaction so provider network calls never
 * sit inside a held DB transaction (it scopes its own writes).
 *
 * Every function takes an optional `db` (default prisma) so tests inject fakes.
 */
import { createHash, randomBytes } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { MYRA_LIMITS } from "../contracts"
import type { MyraOperationStatus, MyraPrincipal } from "../contracts"
import { err } from "./errors"
import { ownerWhere, withOwnerScope } from "./db"
import type { MyraDb } from "./db"

const TERMINAL: ReadonlySet<MyraOperationStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "OUTCOME_UNKNOWN",
  "EXPIRED",
  "CANCELED",
])

/** Thrown by an executor that may have submitted to a provider already. */
export class OutcomeUnknownError extends Error {
  constructor(message = "Provider outcome unknown") {
    super(message)
    this.name = "OutcomeUnknownError"
  }
}

export interface OperationContext {
  principal: MyraPrincipal
  conversationId?: string | null
  workspaceId?: string | null
  /** Test/fake injection or an already-bound transaction. */
  db?: MyraDb
  /** Test seams for external boundaries. Production omits. */
  deps?: {
    sendNotification?: typeof import("@lyrashield/integrations").sendNotification
  }
}

export interface ProposalRecord {
  id: string
  operationName: string
  status: MyraOperationStatus
  payload: unknown
  inputHash: string
  idempotencyKey: string
  expiresAt: Date
  result: unknown
}

/** Executor result: `result` persists on the row; `privateResult` is returned
 * to the confirming caller only (e.g. one-time booking manage tokens). */
export interface ExecutorOutcome {
  result: unknown
  privateResult?: Record<string, unknown>
}
export type OperationExecutor = (
  payload: Record<string, unknown>,
  ctx: OperationContext
) => Promise<ExecutorOutcome>

export function hashOperationPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

function newIdempotencyKey(): string {
  return randomBytes(16).toString("base64url")
}

function ownsProposal(
  principal: MyraPrincipal,
  proposal: { accountId: string | null; publicSessionId: string | null }
): boolean {
  if (principal.kind === "user") return proposal.accountId === principal.accountId
  if (principal.kind === "anonymous") {
    return proposal.publicSessionId === principal.publicSessionId
  }
  return false
}

export async function createProposal(
  ctx: OperationContext,
  operationName: string,
  payload: Record<string, unknown>,
  opts: { idempotencyKey?: string; db?: MyraDb } = {}
): Promise<ProposalRecord> {
  const db = opts.db ?? ctx.db ?? prisma
  const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey()
  const inputHash = hashOperationPayload(payload)
  const expiresAt = new Date(Date.now() + MYRA_LIMITS.proposalTtlMinutes * 60 * 1000)

  return withOwnerScope(
    ctx.principal,
    async (tx) => {
      // Idempotent replay: same operation + key returns the live proposal.
      const existing = await tx.myraOperation.findUnique({
        where: { operationName_idempotencyKey: { operationName, idempotencyKey } },
      })
      if (existing && !TERMINAL.has(existing.status)) return existing as ProposalRecord

      const row = await tx.myraOperation.create({
        data: {
          operationName,
          status: "AWAITING_CONFIRMATION",
          ...ownerWhere(ctx.principal),
          workspaceId: ctx.workspaceId ?? null,
          conversationId: ctx.conversationId ?? null,
          inputHash,
          payload,
          idempotencyKey,
          expiresAt,
        },
      })
      return row as ProposalRecord
    },
    db
  )
}

/**
 * Confirm and execute a proposal. Rechecks authorization, expiry, payload
 * hash and conversation takeover before running `executor`.
 */
export async function confirm(
  ctx: OperationContext,
  proposalId: string,
  executor: OperationExecutor,
  db: MyraDb = prisma
): Promise<{
  status: MyraOperationStatus
  result: unknown
  privateResult?: Record<string, unknown>
}> {
  // Phase 1 (owner-scoped tx): verify + claim EXECUTING.
  const payload = await withOwnerScope(
    ctx.principal,
    async (tx) => {
      const proposal = await tx.myraOperation.findUnique({ where: { id: proposalId } })
      if (!proposal) throw err("NOT_FOUND", "Proposal not found.")
      if (!ownsProposal(ctx.principal, proposal)) {
        throw err("OWNERSHIP_MISMATCH", "This action belongs to a different session.")
      }
      // Re-validate workspace membership at execution time: a role revoked
      // (or removed) between proposal and confirmation must not execute the
      // write. The member row is the authority — principal.role is
      // contractually null on MyraPrincipalUser (the resolved role lives on
      // ResolvedMyraRequest), so do not read it here.
      if (proposal.workspaceId && ctx.principal.kind === "user") {
        const member = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: proposal.workspaceId,
              userId: ctx.principal.accountId,
            },
          },
          select: { status: true },
        })
        if (!member || member.status !== "active") {
          await tx.myraOperation.updateMany({
            where: { id: proposalId, status: "AWAITING_CONFIRMATION" },
            data: { status: "CANCELED" },
          })
          throw err(
            "FORBIDDEN",
            "Your workspace access changed. Ask Myra to prepare it again."
          )
        }
      }
      if (proposal.conversationId) {
        const conversation = await tx.myraConversation.findUnique({
          where: { id: proposal.conversationId },
          select: { state: true, humanTakeoverAt: true },
        })
        if (conversation?.humanTakeoverAt || conversation?.state === "TAKEOVER") {
          await tx.myraOperation.updateMany({
            where: { id: proposalId, status: "AWAITING_CONFIRMATION" },
            data: { status: "CANCELED" },
          })
          throw err("TAKEOVER_ACTIVE", "A person has taken over this conversation.")
        }
      }
      if (proposal.status === "DRAFT") {
        throw err("PROPOSAL_STATE_INVALID", "Proposal is not ready.")
      }
      if (proposal.status !== "AWAITING_CONFIRMATION") {
        throw err("PROPOSAL_STATE_INVALID", `Proposal is ${proposal.status.toLowerCase()}.`)
      }
      if (proposal.expiresAt <= new Date()) {
        await tx.myraOperation.updateMany({
          where: { id: proposalId, status: "AWAITING_CONFIRMATION" },
          data: { status: "EXPIRED" },
        })
        throw err("PROPOSAL_EXPIRED", "This action expired. Ask Myra to prepare it again.")
      }
      if (proposal.inputHash !== hashOperationPayload(proposal.payload)) {
        throw err("PROPOSAL_PAYLOAD_CHANGED", "The confirmed details changed. Review again.")
      }
      // Claim execution exactly once.
      const claimed = await tx.myraOperation.updateMany({
        where: { id: proposalId, status: "AWAITING_CONFIRMATION" },
        data: { status: "EXECUTING", executedAt: new Date() },
      })
      if (claimed.count !== 1) {
        throw err("PROPOSAL_STATE_INVALID", "Proposal already handled.")
      }
      return proposal.payload as Record<string, unknown>
    },
    db
  )

  // Phase 2 (outside the tx): run the executor.
  const execCtx: OperationContext = { ...ctx, db }
  let outcome: ExecutorOutcome
  try {
    outcome = await executor(payload, execCtx)
  } catch (e) {
    const unknown = e instanceof OutcomeUnknownError
    await withOwnerScope(
      ctx.principal,
      (tx) =>
        tx.myraOperation.update({
          where: { id: proposalId },
          data: {
            status: unknown ? "OUTCOME_UNKNOWN" : "FAILED",
            error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
          },
        }),
      db
    )
    if (unknown) return { status: "OUTCOME_UNKNOWN", result: null }
    throw e
  }

  // Phase 3 (owner-scoped tx): record the result.
  await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.myraOperation.update({
        where: { id: proposalId },
        data: { status: "COMPLETED", result: outcome.result as object },
      }),
    db
  )
  return {
    status: "COMPLETED",
    result: outcome.result,
    // Caller-only values (manage tokens, one-time links) — never persisted
    // on the operation row, never merged into the stored result.
    privateResult: outcome.privateResult,
  }
}

export async function cancel(
  ctx: OperationContext,
  proposalId: string,
  db: MyraDb = prisma
): Promise<{ status: MyraOperationStatus }> {
  return withOwnerScope(
    ctx.principal,
    async (tx) => {
      const proposal = await tx.myraOperation.findUnique({ where: { id: proposalId } })
      if (!proposal) throw err("NOT_FOUND", "Proposal not found.")
      if (!ownsProposal(ctx.principal, proposal)) {
        throw err("OWNERSHIP_MISMATCH", "This action belongs to a different session.")
      }
      if (TERMINAL.has(proposal.status)) return { status: proposal.status }
      await tx.myraOperation.update({
        where: { id: proposalId },
        data: { status: "CANCELED" },
      })
      return { status: "CANCELED" as MyraOperationStatus }
    },
    db
  )
}

/** Cancel every non-terminal proposal for a conversation (takeover/logout). */
export async function invalidateForConversation(
  conversationId: string,
  db: MyraDb = prisma
): Promise<number> {
  const res = await db.myraOperation.updateMany({
    where: { conversationId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] } },
    data: { status: "CANCELED" },
  })
  return res.count
}

/** Sweep proposals past expiry into EXPIRED. Returns the count updated. */
export async function expireSweep(db: MyraDb = prisma): Promise<number> {
  const res = await db.myraOperation.updateMany({
    where: {
      status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  })
  return res.count
}
