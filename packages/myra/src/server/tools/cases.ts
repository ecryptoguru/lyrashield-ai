/**
 * Support-case tools. propose_support_case / submit_support_case only ever
 * create an operation proposal — the case persists exactly once inside the
 * confirmation engine via executeSubmitSupportCase. send_case_reply executes
 * directly: the Send click is the confirmation for a user-authored reply.
 */
import { randomInt } from "node:crypto"
import { z } from "zod"
import { env } from "@lyrashield/config"
import { prisma } from "@lyrashield/db"
import { sendNotification } from "@lyrashield/integrations"
import { MYRA_COPY, submitCasePayloadSchema, type SubmitCasePayload } from "../../contracts"
import { err } from "../errors"
import { createProposal } from "../operations"
import type { ExecutorOutcome, OperationContext } from "../operations"
import { findVerifiedEmail } from "../verify"
import { ownerWhere, withOwnerScope, withTrustedScope, MYRA_TRUSTED_INTERNAL } from "../db"
import type { MyraDb } from "../db"
import type { MyraToolContext, MyraToolResult, ProposalSummary } from "./types"

const SUPPORT_INBOX = "support@lyrashieldai.com"

export const proposeSupportCaseInput = submitCasePayloadSchema
export const submitSupportCaseInput = submitCasePayloadSchema
export const readOwnCaseInput = z.object({
  caseId: z.string().max(80).optional(),
  reference: z.string().max(20).optional(),
})
export const sendCaseReplyInput = z.object({
  caseId: z.string().max(80),
  body: z.string().min(1).max(4000),
})

// ─── Payload normalization + verification gates ───────────────────────────

async function accountEmail(accountId: string, db: MyraDb): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: accountId },
    select: { email: true },
  })
  return user?.email ?? null
}

async function resolveReplyDestination(
  ctx: MyraToolContext,
  payload: SubmitCasePayload
): Promise<{ replyEmail: string; verifiedAt: Date | null }> {
  if (ctx.principal.kind === "user") {
    const email =
      payload.replyEmail ?? (await accountEmail(ctx.principal.accountId, ctx.db ?? prisma))
    if (!email) throw err("VERIFICATION_REQUIRED", "Your account has no reply email.")
    return { replyEmail: email, verifiedAt: null }
  }
  // Anonymous: a verified reply destination is mandatory before any case
  // preview. Never reveals whether the address already has cases.
  if (ctx.principal.kind !== "anonymous") throw err("FORBIDDEN", "Operators cannot draft cases.")
  const email = payload.replyEmail?.trim().toLowerCase()
  if (!email) {
    throw err("VERIFICATION_REQUIRED", "Verify your reply email to send a case.")
  }
  const verified = await findVerifiedEmail(
    email,
    "support_case",
    ctx.principal.publicSessionId,
    ctx.db ?? prisma
  )
  if (!verified) {
    throw err("VERIFICATION_REQUIRED", "Verify your reply email to send a case.")
  }
  return { replyEmail: email, verifiedAt: verified.consumedAt }
}

function toProposalSummary(
  proposal: { id: string; operationName: string; expiresAt: Date },
  title: string,
  description: string,
  payloadPreview: Record<string, unknown>
): ProposalSummary {
  return {
    id: proposal.id,
    operationName: proposal.operationName,
    title,
    description,
    payloadPreview,
    expiresAt: proposal.expiresAt.toISOString(),
  }
}

function casePreview(proposal: ProposalSummary, payload: SubmitCasePayload, replyTo: string) {
  return {
    type: "support_case_preview" as const,
    proposalId: proposal.id,
    subject: payload.subject,
    summary: payload.summary,
    replyDestination: replyTo,
    includeDiagnostics: payload.includeDiagnostics,
    includeTranscriptExcerpt: payload.includeTranscriptExcerpt,
    expiresAt: proposal.expiresAt,
  }
}

// ─── Tools ────────────────────────────────────────────────────────────────

export async function runProposeSupportCase(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const payload = proposeSupportCaseInput.parse(input)
  const { replyEmail } = await resolveReplyDestination(ctx, payload)
  const storedPayload = { ...payload, replyEmail }
  const proposal = await createProposal(
    {
      principal: ctx.principal,
      conversationId: ctx.conversationId,
      workspaceId: ctx.workspaceId,
    },
    "submit_support_case",
    storedPayload,
    { db: ctx.db }
  )
  const summary = toProposalSummary(proposal, "Send support request", MYRA_COPY.caseDraft, {
    subject: payload.subject,
    includeDiagnostics: payload.includeDiagnostics,
  })
  return {
    data: { proposalId: proposal.id, expiresAt: summary.expiresAt },
    components: [casePreview(summary, payload, replyEmail)],
    proposals: [summary],
  }
}

/** Confirmed-write: produces the same proposal — never executes inline. */
export async function runSubmitSupportCase(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  return runProposeSupportCase(ctx, input)
}

// ─── Confirmed executor (invoked by the operations engine) ────────────────

function newCaseReference(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  let suffix = ""
  for (let i = 0; i < 6; i++) suffix += alphabet[randomInt(alphabet.length)]
  return `LS-${suffix}`
}

export async function executeSubmitSupportCase(
  payload: Record<string, unknown>,
  ctx: OperationContext
): Promise<ExecutorOutcome> {
  const parsed = submitCasePayloadSchema.parse(payload)

  // Re-verify the reply destination at execution time.
  let replyEmail: string | null = null
  let emailVerifiedAt: Date | null = null
  if (ctx.principal.kind === "user") {
    replyEmail =
      parsed.replyEmail ?? (await accountEmail(ctx.principal.accountId, ctx.db ?? prisma))
    if (!replyEmail) throw err("VERIFICATION_REQUIRED", "Your account has no reply email.")
  } else if (ctx.principal.kind === "anonymous") {
    const email = parsed.replyEmail?.trim().toLowerCase()
    if (!email) throw err("VERIFICATION_REQUIRED", "Verify your reply email first.")
    const verified = await findVerifiedEmail(
      email,
      "support_case",
      ctx.principal.publicSessionId,
      ctx.db ?? prisma
    )
    if (!verified) throw err("VERIFICATION_REQUIRED", "Verify your reply email first.")
    replyEmail = email
    emailVerifiedAt = verified.consumedAt
  } else {
    throw err("FORBIDDEN", "Operators cannot submit cases.")
  }

  // Persist once. A reference collision retries with a fresh reference —
  // the row is written exactly once or not at all.
  let supportCase: { id: string; reference: string } | null = null
  for (let attempt = 0; attempt < 3 && !supportCase; attempt++) {
    try {
      supportCase = await withOwnerScope(
        ctx.principal,
        (tx) =>
          tx.supportCase.create({
            data: {
              reference: newCaseReference(),
              subject: parsed.subject,
              summary: parsed.summary,
              ...ownerWhere(ctx.principal),
              workspaceId: ctx.workspaceId ?? null,
              replyEmail,
              emailVerifiedAt,
              conversationId: ctx.conversationId ?? null,
              notificationState: "pending",
            },
            select: { id: true, reference: true },
          }),
        ctx.db
      )
    } catch (e) {
      // Unique-reference collision → retry; other errors propagate.
      if (attempt === 2 || !String(e).includes("reference")) throw e
    }
  }
  if (!supportCase) throw err("INTERNAL_ERROR", "Could not save your request.")

  // Notification is a separate fact from persistence — failure keeps the
  // case and surfaces the delivery state to the operator.
  const notificationState = await notifyCaseCreated(
    supportCase.id,
    parsed.subject,
    ctx.db ?? prisma,
    ctx.deps?.sendNotification
  )
  return {
    result: {
      caseId: supportCase.id,
      reference: supportCase.reference,
      notificationState,
      copy:
        notificationState === "sent"
          ? MYRA_COPY.caseSaved(supportCase.reference)
          : MYRA_COPY.caseDeliveryProblem,
    },
  }
}

async function notifyCaseCreated(
  caseId: string,
  subject: string,
  db: MyraDb,
  send: typeof sendNotification = sendNotification
): Promise<string> {
  const sent = await send(
    "email",
    {
      type: "myra_support_case",
      title: `New support case: ${subject.slice(0, 120)}`,
      body: "A new support case was submitted through Myra. Open the support inbox to review.",
      metadata: { caseId },
    },
    [env.MYRA_SUPPORT_NOTIFY_EMAIL || SUPPORT_INBOX]
  ).catch(() => false)
  const state = sent ? "sent" : "failed"
  // Marks the case notified after the email attempt — an ambient caller
  // reaches this with no owner context bound, so the write declares itself
  // through the internal trusted path (v18 1.3).
  await withTrustedScope(
    MYRA_TRUSTED_INTERNAL,
    (tx) => tx.supportCase.update({ where: { id: caseId }, data: { notificationState: state } }),
    db
  ).catch(() => {})
  return state
}

// ─── Owned-case reads and replies ─────────────────────────────────────────

async function findOwnedCase(
  ctx: MyraToolContext,
  idOrRef: { caseId?: string; reference?: string }
) {
  const where = {
    ...ownerWhere(ctx.principal),
    ...(idOrRef.caseId ? { id: idOrRef.caseId } : {}),
    ...(idOrRef.reference ? { reference: idOrRef.reference } : {}),
  }
  const found = await withOwnerScope(
    ctx.principal,
    (tx) => tx.supportCase.findFirst({ where }),
    ctx.db
  )
  if (!found) throw err("NOT_FOUND", "Case not found.")
  return found
}

export async function runReadOwnCase(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { caseId, reference } = readOwnCaseInput.parse(input)
  if (!caseId && !reference) throw err("VALIDATION_ERROR", "caseId or reference is required.")
  const supportCase = await findOwnedCase(ctx, { caseId, reference })
  const replies = await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.supportCaseReply.findMany({
        where: { caseId: supportCase.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, authorType: true, body: true, createdAt: true },
      }),
    ctx.db
  )
  return {
    data: {
      case: {
        id: supportCase.id,
        reference: supportCase.reference,
        status: supportCase.status,
        subject: supportCase.subject,
        createdAt: supportCase.createdAt.toISOString(),
        resolvedAt: supportCase.resolvedAt?.toISOString() ?? null,
      },
      replies: replies.map((r) => ({
        id: r.id,
        authorType: r.authorType,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    },
  }
}

export async function runSendCaseReply(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { caseId, body } = sendCaseReplyInput.parse(input)
  const supportCase = await findOwnedCase(ctx, { caseId })
  // Anonymous replies require the case's verified reply identity.
  if (ctx.principal.kind === "anonymous" && !supportCase.emailVerifiedAt) {
    throw err("VERIFICATION_REQUIRED", "Verify your email before replying.")
  }
  if (supportCase.status === "RESOLVED") {
    throw err("PROPOSAL_STATE_INVALID", "This case is resolved.")
  }
  const reply = await withOwnerScope(
    ctx.principal,
    async (tx) => {
      const created = await tx.supportCaseReply.create({
        data: {
          caseId: supportCase.id,
          authorType: "USER",
          authorUserId: ctx.principal.kind === "user" ? ctx.principal.accountId : null,
          body,
        },
        select: { id: true, createdAt: true },
      })
      await tx.supportCase.update({
        where: { id: supportCase.id },
        data: {
          lastUserReplyAt: new Date(),
          status: supportCase.status === "PENDING_USER" ? "OPEN" : supportCase.status,
        },
      })
      return created
    },
    ctx.db
  )
  return {
    data: {
      replyId: reply.id,
      caseId: supportCase.id,
      reference: supportCase.reference,
      status: supportCase.status === "PENDING_USER" ? "OPEN" : supportCase.status,
    },
  }
}
