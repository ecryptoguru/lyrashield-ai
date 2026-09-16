/**
 * Myra service surface — conversation/message persistence, the streaming
 * task loop, proposal confirm/cancel, owned-case APIs and the operator
 * inbox. Operator functions take the verified operator's userId — callers
 * (route handlers) apply requirePlatformAdmin first.
 */
import { randomUUID } from "node:crypto"
import { env } from "@lyrashield/config"
import { prisma } from "@lyrashield/db"
import { sendNotification } from "@lyrashield/integrations"
import { MYRA_LIMITS } from "../contracts"
import type {
  MyraComponent,
  MyraStreamEvent,
  MyraSurface,
  SupportCaseStatus,
  TaskRecord,
} from "../contracts"
import { screenSecrets } from "../sanitize"
import { err, toMyraError } from "./errors"
import { withOwnerScope, ownerWhere, withTrustedScope, MYRA_TRUSTED_MANAGE_TOKEN } from "./db"
import type { MyraDb } from "./db"
import type { ResolvedMyraRequest } from "./context"
import { newTraceId, runTaskLoop } from "./loop"
import { auditEvent } from "./audit"
import { cancel as cancelOperationProposal, confirm, invalidateForConversation } from "./operations"
import type { OperationContext, OperationExecutor } from "./operations"
import {
  computeDemoSlots,
  executeBookDemo,
  executeManageDemo,
  hashManageToken,
  isManageTokenActive,
  reconcileDemoBooking,
} from "./tools/demo"
import { executeSubmitSupportCase } from "./tools/cases"
import { runReadOwnCase, runSendCaseReply } from "./tools/cases"
import { runTool } from "./tools/registry"
import type { MyraToolContext } from "./tools/types"

export interface HandleMessageInput {
  conversationId?: string
  text: string
  routeContext?: string
  surface: MyraSurface
  sessionMemory?: {
    preferred_timezone?: string
    preferred_locale?: string
    preferred_depth?: "terse" | "detailed"
  }
}

const EXECUTORS: Record<string, OperationExecutor> = {
  submit_support_case: executeSubmitSupportCase,
  book_demo: executeBookDemo,
  manage_own_demo: executeManageDemo,
}

function toolContext(
  ctx: ResolvedMyraRequest,
  conversationId: string | null,
  surface?: MyraSurface
): MyraToolContext {
  return {
    principal: ctx.principal,
    // Anonymous principals are clamped to MARKETING — a claimed DASHBOARD
    // surface must never widen a public session into app-surface starters.
    surface: ctx.principal.kind === "user" ? (surface ?? "DASHBOARD") : "MARKETING",
    conversationId,
    workspaceId: ctx.workspaceId,
    role: ctx.role,
  }
}

// ─── Conversations ────────────────────────────────────────────────────────

async function loadOwnedConversation(ctx: ResolvedMyraRequest, conversationId: string) {
  const conversation = await withOwnerScope(ctx.principal, (tx) =>
    tx.myraConversation.findUnique({ where: { id: conversationId } })
  )
  if (!conversation) throw err("NOT_FOUND", "Conversation not found.")
  const owns =
    ctx.principal.kind === "user"
      ? conversation.accountId === ctx.principal.accountId
      : ctx.principal.kind === "anonymous" &&
        conversation.publicSessionId === ctx.principal.publicSessionId
  if (!owns) throw err("FORBIDDEN", "This conversation belongs to a different session.")
  if (conversation.expiresAt <= new Date()) throw err("NOT_FOUND", "Conversation expired.")
  return conversation
}

async function createConversation(
  ctx: ResolvedMyraRequest,
  surface: MyraSurface,
  routeContext?: string
) {
  const expiresAt = new Date(
    Date.now() + MYRA_LIMITS.conversationRetentionDays * 24 * 60 * 60 * 1000
  )
  return withOwnerScope(ctx.principal, (tx) =>
    tx.myraConversation.create({
      data: {
        surface,
        ...ownerWhere(ctx.principal),
        workspaceId: ctx.principal.kind === "user" ? ctx.workspaceId : null,
        routeContext: routeContext ?? null,
        expiresAt,
      },
    })
  )
}

// ─── Message handling (streaming) ─────────────────────────────────────────

export async function* handleMessage(
  ctx: ResolvedMyraRequest,
  input: HandleMessageInput
): AsyncGenerator<MyraStreamEvent> {
  // The surface gates (MYRA_PUBLIC_ENABLED / MYRA_DASHBOARD_ENABLED) are
  // enforced upstream on the route; there is no separate env kill switch —
  // the unvalidated MYRA_DISABLED process.env read was removed (v18).
  if (!input.text || input.text.length > MYRA_LIMITS.messageMaxChars) {
    yield {
      type: "error",
      error: { code: "VALIDATION_ERROR", message: "Message is empty or too long." },
    }
    return
  }

  const { text: screened, redacted } = screenSecrets(input.text)
  const traceId = newTraceId()
  const assistantMessageId = randomUUID()

  let conversation
  try {
    const clampedSurface = ctx.principal.kind === "user" ? input.surface : "MARKETING"
    conversation = input.conversationId
      ? await loadOwnedConversation(ctx, input.conversationId)
      : await createConversation(ctx, clampedSurface, input.routeContext)
  } catch (e) {
    yield { type: "error", error: toMyraError(e) }
    return
  }
  const conversationId = conversation.id

  // Persist the screened user message before any generation.
  await withOwnerScope(ctx.principal, (tx) =>
    tx.myraMessage.create({
      data: {
        conversationId,
        role: "USER",
        content: screened,
        traceId,
      },
    })
  )
  if (redacted > 0) {
    await auditEvent(ctx.principal.kind === "user" ? "user" : "public_session", {
      accountId: ctx.principal.kind === "user" ? ctx.principal.accountId : null,
      publicSessionId: ctx.principal.kind === "anonymous" ? ctx.principal.publicSessionId : null,
      action: "myra.secret_screened",
      resourceType: "conversation",
      resourceId: conversationId,
      metadata: { redactedCount: redacted, traceId },
    })
  }

  // Reconcile any OUTCOME_UNKNOWN booking on this conversation before
  // generating — the deterministic provider event id makes this safe, and
  // the user sees the fresh state in the same turn.
  const unknownBookings = await withOwnerScope(ctx.principal, (tx) =>
    tx.demoBooking.findMany({
      where: { conversationId, status: "OUTCOME_UNKNOWN" },
      select: { id: true },
    })
  ).catch(() => [] as { id: string }[])
  for (const booking of unknownBookings) {
    yield { type: "activity", label: "Checking whether your booking went through." }
    const res = await reconcileDemoBooking(booking.id).catch(() => null)
    if (res?.status === "CONFIRMED") {
      yield {
        type: "activity",
        label: res.copy ?? "Your booking is confirmed.",
      }
    }
  }

  const toolCtx = {
    ...toolContext(ctx, conversationId, input.surface),
    routeContext: input.routeContext,
  }
  let answerText = ""
  const components: MyraComponent[] = []
  let taskRecord: TaskRecord = {
    intent: "unknown",
    toolsUsed: [],
    outcome: "error",
    unresolved: true,
  }
  try {
    for await (const event of runTaskLoop({
      ctx: toolCtx,
      text: screened,
      routeContext: input.routeContext,
      sessionMemory: ctx.principal.kind === "anonymous" ? input.sessionMemory : undefined,
      assistantMessageId,
      traceId,
    })) {
      if (event.type === "token") answerText += event.text
      if (event.type === "component") components.push(event.component)
      if (event.type === "done") taskRecord = event.taskRecord
      yield event
    }
  } finally {
    // Persist the assistant turn even when the client disconnects — the
    // stream is ephemeral, the record is durable.
    await withOwnerScope(ctx.principal, (tx) =>
      tx.myraMessage.create({
        data: {
          id: assistantMessageId,
          conversationId,
          role: "ASSISTANT",
          content: answerText,
          component: components.length > 0 ? components : undefined,
          taskRecord,
          traceId,
        },
      })
    ).catch(() => {})
  }
}

// ─── Proposal confirm/cancel (route-facing) ───────────────────────────────

export async function confirmProposal(
  ctx: ResolvedMyraRequest,
  proposalId: string
): Promise<{
  status: string
  result: unknown
  /** Private values (e.g. manage tokens) — returned to the caller only, never persisted. */
  privateResult?: Record<string, unknown>
  component: MyraComponent
}> {
  // Fail closed on the validated write gate — the unvalidated
  // MYRA_WRITES_DISABLED process.env switch was removed (Deep Review v18).
  if (env.MYRA_WRITES_ENABLED !== "1") {
    throw err("WRITES_DISABLED", "Actions are temporarily disabled.")
  }
  const proposal = await withOwnerScope(ctx.principal, (tx) =>
    tx.myraOperation.findUnique({ where: { id: proposalId } })
  )
  if (!proposal) throw err("NOT_FOUND", "Proposal not found.")
  const executor = EXECUTORS[proposal.operationName]
  if (!executor) throw err("VALIDATION_ERROR", "Unknown operation.")

  const opCtx: OperationContext = {
    principal: ctx.principal,
    conversationId: proposal.conversationId,
    workspaceId: proposal.workspaceId ?? ctx.workspaceId,
  }
  const outcome = await confirm(opCtx, proposalId, executor)

  const result = (outcome.result ?? {}) as Record<string, unknown>
  const component: MyraComponent = {
    type: "action_result",
    proposalId,
    status: outcome.status,
    title:
      outcome.status === "COMPLETED"
        ? "Done"
        : outcome.status === "OUTCOME_UNKNOWN"
          ? "We are checking whether that went through"
          : "Failed",
    detail:
      typeof result.copy === "string"
        ? result.copy
        : outcome.status === "OUTCOME_UNKNOWN"
          ? "You do not need to submit it again."
          : undefined,
    reference: typeof result.reference === "string" ? result.reference : undefined,
  }
  await auditEvent(ctx.principal.kind === "user" ? "user" : "public_session", {
    accountId: ctx.principal.kind === "user" ? ctx.principal.accountId : null,
    publicSessionId: ctx.principal.kind === "anonymous" ? ctx.principal.publicSessionId : null,
    action: `myra.operation.${outcome.status.toLowerCase()}`,
    resourceType: "myra_operation",
    resourceId: proposalId,
    metadata: { operationName: proposal.operationName },
  })
  return {
    status: outcome.status,
    result: outcome.result,
    privateResult: outcome.privateResult,
    component,
  }
}

export async function cancelProposal(
  ctx: ResolvedMyraRequest,
  proposalId: string
): Promise<{ status: string }> {
  return cancelOperationProposal({ principal: ctx.principal }, proposalId)
}

/** Type-ahead suggestions — retrieval only, never a model call. */
export async function suggest(
  ctx: ResolvedMyraRequest,
  text: string,
  surface: MyraSurface,
  routeContext?: string
) {
  const toolCtx = { ...toolContext(ctx, null, surface), routeContext: routeContext ?? null }
  const result = await runTool("instant_suggest", toolCtx, { text })
  const card = result.components?.find((c) => c.type === "instant_suggestions")
  return {
    suggestions: card?.type === "instant_suggestions" ? card.suggestions : [],
  }
}

// ─── Demo booking (route-facing) ──────────────────────────────────────────

/** Public slot list — shared availability, no attendee data. */
export async function getDemoSlots(timezone: string, from: string) {
  const slots = await computeDemoSlots({ from })
  return {
    timezone,
    hostTimezone: MYRA_LIMITS.demo.hostTimezone,
    durationMinutes: MYRA_LIMITS.demo.durationMinutes,
    slots: slots.map((s) => ({
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  }
}

interface BookingView {
  id: string
  status: string
  startsAt: string
  endsAt: string
  timezone: string
  attendeeEmail: string
  attendeeName: string
  meetLink: string | null
  conferenceState: string
  organizerEmail: string
}

function toBookingView(b: {
  id: string
  status: string
  startsAt: Date
  endsAt: Date
  timezone: string
  attendeeEmail: string
  attendeeName: string
  meetLink: string | null
  conferenceState: string
  organizerEmail: string
}): BookingView {
  return {
    id: b.id,
    status: b.status,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    timezone: b.timezone,
    attendeeEmail: b.attendeeEmail,
    attendeeName: b.attendeeName,
    meetLink: b.meetLink,
    conferenceState: b.conferenceState,
    organizerEmail: b.organizerEmail,
  }
}

/**
 * Token-gated booking management. The manage token IS the credential (hash
 * match, timing-safe) and the holder's POST is the confirming gesture — same
 * as the Send-click rule for case replies. "get" reconciles an unknown
 * outcome first, so a retry never duplicates an event.
 */
export async function manageBooking(
  manageToken: string,
  action: "get" | "cancel" | "reschedule",
  newSlotStart?: string,
  db: MyraDb = prisma
) {
  const tokenHash = hashManageToken(manageToken)
  // The manage token IS the credential — the hash lookup precedes any owner
  // context, so it declares the manage-token trusted path (v18 1.3).
  const booking = await withTrustedScope(
    MYRA_TRUSTED_MANAGE_TOKEN,
    (tx) => tx.demoBooking.findUnique({ where: { manageTokenHash: tokenHash } }).catch(() => null),
    db
  )
  if (!booking || !isManageTokenActive(booking)) {
    throw err("FORBIDDEN", "Invalid or expired booking management link.")
  }

  if (action === "get") {
    if (booking.status === "OUTCOME_UNKNOWN") {
      const res = await reconcileDemoBooking(booking.id, db).catch(() => null)
      if (res?.status === "CONFIRMED") {
        const fresh = await withTrustedScope(
          MYRA_TRUSTED_MANAGE_TOKEN,
          (tx) => tx.demoBooking.findUnique({ where: { id: booking.id } }),
          db
        )
        return { booking: toBookingView(fresh ?? booking), copy: res.copy }
      }
      return { booking: toBookingView(booking), copy: res?.copy }
    }
    return { booking: toBookingView(booking) }
  }

  if (booking.status === "CANCELED") {
    throw err("PROPOSAL_STATE_INVALID", "This booking is already canceled.")
  }
  if (action === "reschedule" && !newSlotStart) {
    throw err("VALIDATION_ERROR", "newSlotStart is required to reschedule.")
  }

  const outcome = await executeManageDemo(
    {
      bookingId: booking.id,
      manageToken,
      action,
      ...(newSlotStart ? { newSlotStart } : {}),
    },
    {
      principal: {
        kind: "anonymous",
        publicSessionId: booking.publicSessionId ?? `manage:${booking.id}`,
      },
      conversationId: booking.conversationId,
      workspaceId: null,
      db,
    }
  )
  await auditEvent("public_session", {
    publicSessionId: booking.publicSessionId,
    action: `myra.demo.${action}`,
    resourceType: "demo_booking",
    resourceId: booking.id,
  })
  const result = (outcome.result ?? {}) as Record<string, unknown>
  const freshId =
    typeof result.bookingId === "string" && result.status !== "CANCELED"
      ? result.bookingId
      : booking.id
  const fresh = await withTrustedScope(
    MYRA_TRUSTED_MANAGE_TOKEN,
    (tx) => tx.demoBooking.findUnique({ where: { id: freshId } }),
    db
  )
  return {
    booking: toBookingView(fresh ?? booking),
    result: outcome.result,
    // One-time manage token for the replacement booking (reschedule only).
    ...(outcome.privateResult?.manageToken
      ? { manageToken: outcome.privateResult.manageToken }
      : {}),
  }
}

// ─── Owned cases (route-facing) ───────────────────────────────────────────

export async function listOwnCases(ctx: ResolvedMyraRequest) {
  return withOwnerScope(ctx.principal, (tx) =>
    tx.supportCase.findMany({
      where: ownerWhere(ctx.principal),
      orderBy: [{ updatedAt: "desc" }],
      take: 50,
      select: {
        id: true,
        reference: true,
        status: true,
        subject: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  )
}

export async function getOwnCase(ctx: ResolvedMyraRequest, idOrRef: string) {
  const toolCtx = toolContext(ctx, null)
  const result = await runReadOwnCase(
    toolCtx,
    idOrRef.startsWith("LS-") ? { reference: idOrRef } : { caseId: idOrRef }
  )
  return result.data
}

export async function replyToOwnCase(ctx: ResolvedMyraRequest, caseId: string, body: string) {
  const screened = screenSecrets(body)
  const toolCtx = toolContext(ctx, null)
  const result = await runSendCaseReply(toolCtx, { caseId, body: screened.text })
  await auditEvent(ctx.principal.kind === "user" ? "user" : "public_session", {
    accountId: ctx.principal.kind === "user" ? ctx.principal.accountId : null,
    publicSessionId: ctx.principal.kind === "anonymous" ? ctx.principal.publicSessionId : null,
    action: "myra.case.user_reply",
    resourceType: "support_case",
    resourceId: caseId,
  })
  return result.data
}

export async function clearAccountMemory(ctx: ResolvedMyraRequest) {
  if (ctx.principal.kind !== "user") {
    throw err("UNAUTHORIZED", "Memory is available for signed-in accounts only.")
  }
  const result = await runTool("clear_memory", toolContext(ctx, null), {})
  await auditEvent("user", {
    accountId: ctx.principal.accountId,
    action: "myra.memory.clear",
    resourceType: "myra_memory",
  })
  return result.data
}

// ─── Operator inbox (service-layer authz applied by callers) ──────────────

export async function listOperatorCases(
  opts: { status?: SupportCaseStatus; cursor?: string; limit?: number },
  operatorId: string,
  db: MyraDb = prisma
) {
  const take = Math.min(opts.limit ?? 50, 200)
  const rows = await db.supportCase.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      reference: true,
      status: true,
      subject: true,
      createdAt: true,
      updatedAt: true,
      assigneeUserId: true,
      takenOverAt: true,
      lastUserReplyAt: true,
      notificationState: true,
    },
  })
  const cases = rows.slice(0, take)
  const nextCursor = rows.length > take ? cases[cases.length - 1]!.id : null
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.list_cases",
      resourceType: "support_case",
      metadata: { count: cases.length, status: opts.status ?? null },
    },
    db
  )
  return { cases, nextCursor }
}

export async function getOperatorCase(operatorId: string, caseId: string, db: MyraDb = prisma) {
  const supportCase = await db.supportCase.findUnique({ where: { id: caseId } })
  if (!supportCase) throw err("NOT_FOUND", "Case not found.")
  const replies = await db.supportCaseReply.findMany({
    where: { caseId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  // Permitted conversation history for the operator — the linked transcript,
  // bounded, roles and components only (no raw stream internals).
  const messages = supportCase.conversationId
    ? await db.myraMessage.findMany({
        where: { conversationId: supportCase.conversationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
        select: { id: true, role: true, content: true, createdAt: true, traceId: true },
      })
    : []
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.view_case",
      resourceType: "support_case",
      resourceId: caseId,
      workspaceId: supportCase.workspaceId,
    },
    db
  )
  return { case: supportCase, replies, messages }
}

export async function operatorReply(
  operatorId: string,
  caseId: string,
  body: string,
  db: MyraDb = prisma
) {
  const supportCase = await db.supportCase.findUnique({ where: { id: caseId } })
  if (!supportCase) throw err("NOT_FOUND", "Case not found.")
  const reply = await db.supportCaseReply.create({
    data: {
      caseId,
      authorType: "OPERATOR",
      authorUserId: operatorId,
      body: screenSecrets(body).text,
    },
    select: { id: true, createdAt: true },
  })
  await db.supportCase.update({
    where: { id: caseId },
    data: {
      lastOperatorReplyAt: new Date(),
      status: supportCase.status === "NEW" ? "OPEN" : supportCase.status,
    },
  })
  // Best-effort offline notification — minimal detail, no message body.
  const destination =
    supportCase.replyEmail ??
    (supportCase.accountId
      ? (
          await db.user.findUnique({
            where: { id: supportCase.accountId },
            select: { email: true },
          })
        )?.email
      : null)
  if (destination) {
    await sendNotification(
      "email",
      {
        type: "myra_case_reply",
        title: `Update on your LyraShield support case ${supportCase.reference}`,
        body: "You have a new reply on your support case. Sign in to view it.",
      },
      [destination]
    ).catch(() => false)
  }
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.reply",
      resourceType: "support_case",
      resourceId: caseId,
      workspaceId: supportCase.workspaceId,
    },
    db
  )
  return reply
}

/**
 * Takeover: pause Myra on the conversation and cancel its unexecuted
 * proposals. A late AI write cannot execute after this returns.
 */
export async function operatorTakeover(operatorId: string, caseId: string, db: MyraDb = prisma) {
  const supportCase = await db.supportCase.findUnique({ where: { id: caseId } })
  if (!supportCase) throw err("NOT_FOUND", "Case not found.")
  const now = new Date()
  await db.supportCase.update({
    where: { id: caseId },
    data: { takenOverAt: now, assigneeUserId: operatorId },
  })
  let canceledProposals = 0
  if (supportCase.conversationId) {
    await db.myraConversation.update({
      where: { id: supportCase.conversationId },
      data: { state: "TAKEOVER", humanTakeoverAt: now },
    })
    canceledProposals = await invalidateForConversation(supportCase.conversationId, db)
  }
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.takeover",
      resourceType: "support_case",
      resourceId: caseId,
      workspaceId: supportCase.workspaceId,
      metadata: { conversationId: supportCase.conversationId, canceledProposals },
    },
    db
  )
  return { takenOverAt: now, canceledProposals }
}

/** Explicit operator control to hand the conversation back to Myra. */
export async function operatorRelease(
  operatorId: string,
  caseId: string,
  handoffSummary: string,
  db: MyraDb = prisma
) {
  const screenedSummary = screenSecrets(handoffSummary.trim()).text
  if (screenedSummary.length < 10 || screenedSummary.length > 4000) {
    throw err("VALIDATION_ERROR", "A reviewed handoff summary is required.")
  }
  const supportCase = await db.supportCase.findUnique({ where: { id: caseId } })
  if (!supportCase) throw err("NOT_FOUND", "Case not found.")
  await db.supportCase.update({
    where: { id: caseId },
    data: {
      takenOverAt: null,
      handoffSummary: screenedSummary,
      handoffReviewedAt: new Date(),
      handoffReviewedBy: operatorId,
    },
  })
  if (supportCase.conversationId) {
    await db.myraConversation.update({
      where: { id: supportCase.conversationId },
      data: { state: "ACTIVE", humanTakeoverAt: null },
    })
  }
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.release",
      resourceType: "support_case",
      resourceId: caseId,
      workspaceId: supportCase.workspaceId,
    },
    db
  )
  return { released: true }
}

export async function operatorAssign(operatorId: string, caseId: string, db: MyraDb = prisma) {
  const supportCase = await db.supportCase.findUnique({ where: { id: caseId } })
  if (!supportCase) throw err("NOT_FOUND", "Case not found.")
  await db.supportCase.update({
    where: { id: caseId },
    data: { assigneeUserId: operatorId },
  })
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.assign",
      resourceType: "support_case",
      resourceId: caseId,
      workspaceId: supportCase.workspaceId,
    },
    db
  )
  return { assigneeUserId: operatorId }
}

export async function operatorSetStatus(
  operatorId: string,
  caseId: string,
  status: SupportCaseStatus,
  db: MyraDb = prisma
) {
  const supportCase = await db.supportCase.findUnique({ where: { id: caseId } })
  if (!supportCase) throw err("NOT_FOUND", "Case not found.")
  await db.supportCase.update({
    where: { id: caseId },
    data: {
      status,
      resolvedAt: status === "RESOLVED" ? new Date() : null,
    },
  })
  await auditEvent(
    "operator",
    {
      operatorId,
      action: "myra.operator.set_status",
      resourceType: "support_case",
      resourceId: caseId,
      workspaceId: supportCase.workspaceId,
      metadata: { status },
    },
    db
  )
  return { status }
}
