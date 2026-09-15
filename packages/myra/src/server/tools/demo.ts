/**
 * Demo booking tools. get_demo_slots is a read; book_demo and
 * manage_own_demo are confirmed-writes — they produce operation proposals
 * and execute only through the confirmation engine.
 *
 * Schedule (founder-resolved): Asia/Kolkata weekdays 15:00–20:00, 30-minute
 * slots, 15-minute buffers, ≥24h notice, 14-day horizon. Overlap protection
 * covers the buffered interval, not just the start time.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import {
  bookDemoPayloadSchema,
  demoSlotsRequestSchema,
  manageDemoRequestSchema,
  MYRA_COPY,
  MYRA_LIMITS,
} from "../../contracts"
import {
  CalendarConflictError,
  CalendarTimeoutError,
  getCalendarAdapter,
  zonedParts,
  zonedWallToUtc,
  type CalendarAdapter,
} from "../calendar/adapter"
import { err, MyraServiceError } from "../errors"
import { createProposal, OutcomeUnknownError } from "../operations"
import type { ExecutorOutcome, OperationContext } from "../operations"
import { findVerifiedEmail } from "../verify"
import { withOwnerScope } from "../db"
import type { MyraDb } from "../db"
import type { MyraToolContext, MyraToolResult } from "./types"

export const getDemoSlotsInput = demoSlotsRequestSchema
export const bookDemoInput = bookDemoPayloadSchema
export const manageOwnDemoInput = z
  .object({ bookingId: z.string().max(80).optional(), manageToken: z.string().min(10).max(120) })
  .merge(manageDemoRequestSchema)

const D = MYRA_LIMITS.demo
const SLOT_STEP_MIN = 30
const MAX_SLOTS = 24
const ACTIVE_BOOKING_STATUSES = ["HELD", "CONFIRMED", "OUTCOME_UNKNOWN"] as const

export interface DemoSlot {
  id: string
  startsAt: Date
  endsAt: Date
}

function slotId(start: Date): string {
  return `s_${start.getTime()}`
}

/** Weekday + window bounds for a candidate UTC instant, in host tz. */
function isOnGrid(start: Date, end: Date): boolean {
  const s = zonedParts(start, D.hostTimezone)
  const e = zonedParts(end, D.hostTimezone)
  if (s.date !== e.date) return false
  if (s.weekday === "Sat" || s.weekday === "Sun") return false
  return s.minutes >= D.hostStartHour * 60 && e.minutes <= D.hostEndHour * 60
}

async function overlapsHeld(
  holdStart: Date,
  holdEnd: Date,
  adapter: CalendarAdapter,
  db: MyraDb,
  excludeBookingId?: string
): Promise<boolean> {
  const busy = await adapter.listBusy(holdStart, holdEnd)
  if (busy.some((b) => b.start < holdEnd && b.end > holdStart)) return true
  const conflict = await db.demoBooking.findFirst({
    where: {
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      holdStartsAt: { lt: holdEnd },
      holdEndsAt: { gt: holdStart },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    select: { id: true },
  })
  return conflict !== null
}

/**
 * Compute bookable slots in the requested window. `from` is a YYYY-MM-DD
 * window start clamped to the notice/horizon rules.
 */
export async function computeDemoSlots(
  opts: { from?: string; adapter?: CalendarAdapter; db?: MyraDb } = {}
): Promise<DemoSlot[]> {
  const adapter = opts.adapter ?? getCalendarAdapter()
  const db = opts.db ?? prisma
  const now = Date.now()
  const minStart = now + D.minNoticeHours * 60 * 60 * 1000
  const horizonEnd = now + D.horizonDays * 24 * 60 * 60 * 1000

  // Host-tz date for each horizon day.
  const todayHost = zonedParts(new Date(now), D.hostTimezone).date
  const days: string[] = []
  for (let i = 0; i <= D.horizonDays; i++) {
    const day = new Date(Date.parse(`${todayHost}T00:00:00Z`) + i * 86_400_000)
      .toISOString()
      .slice(0, 10)
    if (opts.from && day < opts.from) continue
    days.push(day)
  }

  const rangeStart = new Date(minStart - D.bufferMinutes * 60_000)
  const rangeEnd = new Date(horizonEnd + D.bufferMinutes * 60_000)
  const busy = await adapter.listBusy(rangeStart, rangeEnd)
  const held = await db.demoBooking.findMany({
    where: {
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      holdStartsAt: { lt: rangeEnd },
      holdEndsAt: { gt: rangeStart },
    },
    select: { holdStartsAt: true, holdEndsAt: true },
  })
  const blocked = [
    ...busy.map((b) => ({ start: b.start, end: b.end })),
    ...held.map((b) => ({ start: b.holdStartsAt, end: b.holdEndsAt })),
  ]

  const slots: DemoSlot[] = []
  for (const day of days) {
    for (
      let m = D.hostStartHour * 60;
      m + D.durationMinutes <= D.hostEndHour * 60;
      m += SLOT_STEP_MIN
    ) {
      const start = zonedWallToUtc(day, m, D.hostTimezone)
      const end = new Date(start.getTime() + D.durationMinutes * 60_000)
      if (start.getTime() < minStart || end.getTime() > horizonEnd) continue
      const holdStart = new Date(start.getTime() - D.bufferMinutes * 60_000)
      const holdEnd = new Date(end.getTime() + D.bufferMinutes * 60_000)
      if (blocked.some((b) => b.start < holdEnd && b.end > holdStart)) continue
      slots.push({ id: slotId(start), startsAt: start, endsAt: end })
      if (slots.length >= MAX_SLOTS) return slots
    }
  }
  return slots
}

// ─── get_demo_slots ───────────────────────────────────────────────────────

export async function runGetDemoSlots(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { timezone, from } = getDemoSlotsInput.parse(input)
  const slots = await computeDemoSlots({ from, db: ctx.db })
  return {
    data: {
      slotCount: slots.length,
      timezone,
      hostTimezone: D.hostTimezone,
      durationMinutes: D.durationMinutes,
      copy: slots.length === 0 ? MYRA_COPY.demoNoSlots : undefined,
    },
    components: [
      {
        type: "slot_picker",
        displayTimezone: timezone,
        slots: slots.map((s) => ({
          id: s.id,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
        })),
      },
    ],
  }
}

// ─── book_demo (proposal + executor) ──────────────────────────────────────

async function verifyAttendee(
  ctx: MyraToolContext,
  email: string
): Promise<{ verifiedAt: Date | null }> {
  const normalized = email.trim().toLowerCase()
  if (ctx.principal.kind === "user") {
    const user = await (ctx.db ?? prisma).user.findUnique({
      where: { id: ctx.principal.accountId },
      select: { email: true },
    })
    if (user?.email.trim().toLowerCase() === normalized) return { verifiedAt: null }
  }
  const verified = await findVerifiedEmail(
    normalized,
    "demo_booking",
    ctx.principal.kind === "anonymous" ? ctx.principal.publicSessionId : null,
    ctx.db ?? prisma
  )
  if (!verified) {
    throw err("VERIFICATION_REQUIRED", "Verify your email to book a demo.")
  }
  return { verifiedAt: verified.consumedAt }
}

export async function runBookDemo(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const payload = bookDemoInput.parse(input)
  // Fail fast at proposal time — the executor re-checks regardless.
  const start = new Date(payload.slotStart)
  const end = new Date(start.getTime() + D.durationMinutes * 60_000)
  if (
    Number.isNaN(start.valueOf()) ||
    !isOnGrid(start, end) ||
    start.getTime() < Date.now() + D.minNoticeHours * 3_600_000
  ) {
    throw err("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
  }
  await verifyAttendee(ctx, payload.email)
  const proposal = await createProposal(
    {
      principal: ctx.principal,
      conversationId: ctx.conversationId,
      workspaceId: ctx.workspaceId,
    },
    "book_demo",
    payload,
    { db: ctx.db }
  )
  const when = new Date(payload.slotStart).toISOString()
  return {
    data: { proposalId: proposal.id },
    components: [
      {
        type: "action_confirmation",
        proposalId: proposal.id,
        title: "Confirm your demo",
        description: `${D.durationMinutes}-minute product walkthrough at ${when} (${payload.timezone}). Invite sent to ${payload.email}. ${MYRA_COPY.demoLimit}`,
        confirmLabel: "Book demo",
        expiresAt: proposal.expiresAt.toISOString(),
      },
    ],
    proposals: [
      {
        id: proposal.id,
        operationName: "book_demo",
        title: "Book demo",
        description: `Demo at ${when}`,
        payloadPreview: {
          slotStart: payload.slotStart,
          timezone: payload.timezone,
          name: payload.name,
          email: payload.email,
        },
        expiresAt: proposal.expiresAt.toISOString(),
      },
    ],
  }
}

export function hashManageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export async function executeBookDemo(
  payload: Record<string, unknown>,
  ctx: OperationContext
): Promise<ExecutorOutcome> {
  const parsed = bookDemoPayloadSchema.parse(payload)
  const db = ctx.db ?? prisma
  const adapter = getCalendarAdapter()

  // Re-verify the attendee — confirmation never reuses a stale check.
  const fakeToolCtx = {
    principal: ctx.principal,
    surface: "MARKETING" as const,
    conversationId: ctx.conversationId ?? null,
    workspaceId: ctx.workspaceId ?? null,
    role: null,
    db,
  }
  const { verifiedAt } = await verifyAttendee(fakeToolCtx, parsed.email)

  const start = new Date(parsed.slotStart)
  const end = new Date(start.getTime() + D.durationMinutes * 60_000)
  if (!isOnGrid(start, end) || start.getTime() < Date.now() + D.minNoticeHours * 3_600_000) {
    throw new MyraServiceError("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
  }
  const holdStart = new Date(start.getTime() - D.bufferMinutes * 60_000)
  const holdEnd = new Date(end.getTime() + D.bufferMinutes * 60_000)
  if (await overlapsHeld(holdStart, holdEnd, adapter, db)) {
    throw new MyraServiceError("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
  }

  const bookingId = randomUUID()
  const providerEventId = `myra-demo-${bookingId}`
  const manageToken = randomBytes(32).toString("base64url")
  await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.demoBooking.create({
        data: {
          id: bookingId,
          status: "HELD",
          attendeeEmail: parsed.email.trim().toLowerCase(),
          attendeeName: parsed.name,
          attendeeContext: parsed.context ?? null,
          attendeeVerifiedAt: verifiedAt ?? new Date(),
          startsAt: start,
          endsAt: end,
          holdStartsAt: holdStart,
          holdEndsAt: holdEnd,
          timezone: parsed.timezone,
          organizerEmail: D.organizerEmail,
          providerEventId,
          manageTokenHash: hashManageToken(manageToken),
          idempotencyKey: `${ctx.conversationId ?? "anon"}:${providerEventId}`,
          ...(ctx.principal.kind === "user" ? { accountId: ctx.principal.accountId } : {}),
          ...(ctx.principal.kind === "anonymous"
            ? { publicSessionId: ctx.principal.publicSessionId }
            : {}),
          conversationId: ctx.conversationId ?? null,
        },
      }),
    ctx.db
  )

  try {
    const event = await adapter.insertEvent({
      eventId: providerEventId,
      summary: `LyraShield demo — ${parsed.name}`,
      description: parsed.context,
      start,
      end,
      attendeeEmail: parsed.email,
      attendeeName: parsed.name,
      organizerEmail: D.organizerEmail,
      conferenceRequestId: bookingId,
      requestMeet: true,
    })
    await withOwnerScope(
      ctx.principal,
      (tx) =>
        tx.demoBooking.update({
          where: { id: bookingId },
          data: {
            status: "CONFIRMED",
            meetLink: event.meetLink,
            conferenceState: event.conferenceState,
          },
        }),
      ctx.db
    )
    return {
      result: {
        bookingId,
        status: "CONFIRMED",
        meetLink: event.meetLink,
        conferenceState: event.conferenceState,
        startsAt: start.toISOString(),
        copy:
          event.conferenceState === "pending"
            ? MYRA_COPY.demoMeetPending
            : MYRA_COPY.demoConfirmed(start.toISOString()),
      },
      privateResult: { manageToken },
    }
  } catch (e) {
    if (e instanceof CalendarConflictError) {
      await db.demoBooking.update({
        where: { id: bookingId },
        data: { status: "CANCELED", canceledAt: new Date() },
      })
      throw new MyraServiceError("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
    }
    // Timeout after provider submission: the event may exist. Mark the
    // booking unknown and let the engine record OUTCOME_UNKNOWN — reconcile
    // by event id, never insert a second event.
    await db.demoBooking.update({
      where: { id: bookingId },
      data: { status: "OUTCOME_UNKNOWN" },
    })
    if (e instanceof CalendarTimeoutError || e instanceof OutcomeUnknownError) {
      throw new OutcomeUnknownError(MYRA_COPY.demoUnknown)
    }
    throw e
  }
}

/**
 * Reconcile an OUTCOME_UNKNOWN booking by its deterministic provider event
 * id. Found → CONFIRMED. Absent → retry the insert once with the SAME event
 * id. Never creates a second event.
 */
export async function reconcileDemoBooking(
  bookingId: string,
  db: MyraDb = prisma,
  adapter: CalendarAdapter = getCalendarAdapter()
): Promise<{ status: string; copy?: string }> {
  const booking = await db.demoBooking.findUnique({ where: { id: bookingId } })
  if (!booking) throw err("NOT_FOUND", "Booking not found.")
  if (booking.status !== "OUTCOME_UNKNOWN" || !booking.providerEventId) {
    return { status: booking.status }
  }
  const existing = await adapter.getEvent(booking.providerEventId).catch(() => null)
  if (existing) {
    await db.demoBooking.update({
      where: { id: bookingId },
      data: {
        status: "CONFIRMED",
        meetLink: existing.meetLink,
        conferenceState: existing.conferenceState,
      },
    })
    return {
      status: "CONFIRMED",
      copy:
        existing.conferenceState === "pending"
          ? MYRA_COPY.demoMeetPending
          : MYRA_COPY.demoConfirmed(booking.startsAt.toISOString()),
    }
  }
  try {
    const event = await adapter.insertEvent({
      eventId: booking.providerEventId,
      summary: `LyraShield demo — ${booking.attendeeName}`,
      description: booking.attendeeContext ?? undefined,
      start: booking.startsAt,
      end: booking.endsAt,
      attendeeEmail: booking.attendeeEmail,
      attendeeName: booking.attendeeName,
      organizerEmail: booking.organizerEmail,
      conferenceRequestId: bookingId,
      requestMeet: true,
    })
    await db.demoBooking.update({
      where: { id: bookingId },
      data: {
        status: "CONFIRMED",
        meetLink: event.meetLink,
        conferenceState: event.conferenceState,
      },
    })
    return {
      status: "CONFIRMED",
      copy:
        event.conferenceState === "pending"
          ? MYRA_COPY.demoMeetPending
          : MYRA_COPY.demoConfirmed(booking.startsAt.toISOString()),
    }
  } catch {
    return { status: "OUTCOME_UNKNOWN", copy: MYRA_COPY.demoUnknown }
  }
}

/**
 * Own-booking read for the "did my booking go through?" path — scoped to the
 * caller's account, public session or conversation, plus the account's own
 * attendee email. Reconciles OUTCOME_UNKNOWN rows by deterministic event id
 * before answering. Never exposes another principal's booking.
 */
export async function readOwnBookings(
  ctx: MyraToolContext,
  adapter: CalendarAdapter = getCalendarAdapter()
): Promise<
  {
    bookingId: string
    status: string
    startsAt: string
    endsAt: string
    timezone: string
    conferenceState: string
    meetLink: string | null
  }[]
> {
  const db = ctx.db ?? prisma
  const ownerFilters: Record<string, unknown>[] = []
  if (ctx.principal.kind === "user") {
    ownerFilters.push({ accountId: ctx.principal.accountId })
    const email = (
      await db.user
        .findUnique({ where: { id: ctx.principal.accountId }, select: { email: true } })
        .catch(() => null)
    )?.email
    if (email) ownerFilters.push({ attendeeEmail: email.trim().toLowerCase() })
  } else if (ctx.principal.kind === "anonymous") {
    ownerFilters.push({ publicSessionId: ctx.principal.publicSessionId })
  } else {
    return []
  }
  if (ctx.conversationId) ownerFilters.push({ conversationId: ctx.conversationId })

  const rows = await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.demoBooking.findMany({
        where: { OR: ownerFilters },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ctx.db
  )

  const out: {
    bookingId: string
    status: string
    startsAt: string
    endsAt: string
    timezone: string
    conferenceState: string
    meetLink: string | null
  }[] = []
  for (const b of rows) {
    let status = b.status
    let conferenceState = b.conferenceState
    let meetLink = b.meetLink
    if (status === "OUTCOME_UNKNOWN") {
      const res = await reconcileDemoBooking(b.id, db, adapter).catch(() => null)
      if (res?.status === "CONFIRMED") {
        status = "CONFIRMED"
        const fresh = await db.demoBooking.findUnique({ where: { id: b.id } })
        conferenceState = fresh?.conferenceState ?? conferenceState
        meetLink = fresh?.meetLink ?? meetLink
      }
    }
    out.push({
      bookingId: b.id,
      status,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      timezone: b.timezone,
      conferenceState,
      meetLink,
    })
  }
  return out
}

// ─── manage_own_demo (proposal + executor) ────────────────────────────────

export async function runManageOwnDemo(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { bookingId, manageToken, action, newSlotStart } = manageOwnDemoInput.parse(input)
  const booking = bookingId
    ? await (ctx.db ?? prisma).demoBooking.findUnique({ where: { id: bookingId } })
    : await (ctx.db ?? prisma).demoBooking
        .findUnique({ where: { manageTokenHash: hashManageToken(manageToken) } })
        .catch(() => null)
  if (!booking || !verifyManageToken(booking.manageTokenHash, manageToken)) {
    throw err("FORBIDDEN", "Invalid booking management link.")
  }
  if (booking.status === "CANCELED") {
    throw err("PROPOSAL_STATE_INVALID", "This booking is already canceled.")
  }
  if (action === "reschedule" && !newSlotStart) {
    throw err("VALIDATION_ERROR", "newSlotStart is required to reschedule.")
  }
  const proposal = await createProposal(
    {
      principal: ctx.principal,
      conversationId: ctx.conversationId,
      workspaceId: ctx.workspaceId,
    },
    "manage_own_demo",
    { bookingId: booking.id, manageToken, action, ...(newSlotStart ? { newSlotStart } : {}) },
    { db: ctx.db }
  )
  return {
    data: { proposalId: proposal.id },
    components: [
      {
        type: "action_confirmation",
        proposalId: proposal.id,
        title: action === "cancel" ? "Cancel this demo?" : "Reschedule this demo?",
        description:
          action === "cancel"
            ? `Cancel the demo booked for ${booking.startsAt.toISOString()}.`
            : `Move the demo to ${newSlotStart}. The original booking is kept until the new one is confirmed.`,
        confirmLabel: action === "cancel" ? "Cancel booking" : "Reschedule",
        expiresAt: proposal.expiresAt.toISOString(),
      },
    ],
    proposals: [
      {
        id: proposal.id,
        operationName: "manage_own_demo",
        title: action === "cancel" ? "Cancel demo" : "Reschedule demo",
        description: `${action} booking for ${booking.startsAt.toISOString()}`,
        payloadPreview: { bookingId: booking.id, action, newSlotStart: newSlotStart ?? null },
        expiresAt: proposal.expiresAt.toISOString(),
      },
    ],
  }
}

function verifyManageToken(storedHash: string | null, token: string): boolean {
  if (!storedHash) return false
  try {
    const candidate = hashManageToken(token)
    if (candidate.length !== storedHash.length) return false
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash))
  } catch {
    return false
  }
}

export async function executeManageDemo(
  payload: Record<string, unknown>,
  ctx: OperationContext
): Promise<ExecutorOutcome> {
  const parsed = manageOwnDemoInput.parse(payload)
  const db = ctx.db ?? prisma
  const adapter = getCalendarAdapter()
  // Resolve by id or by token hash — the manage token IS the credential, and
  // a foreign token must deny, never throw uncoded.
  const booking = parsed.bookingId
    ? await db.demoBooking.findUnique({ where: { id: parsed.bookingId } })
    : await db.demoBooking
        .findUnique({ where: { manageTokenHash: hashManageToken(parsed.manageToken) } })
        .catch(() => null)
  if (!booking || !verifyManageToken(booking.manageTokenHash, parsed.manageToken)) {
    throw err("FORBIDDEN", "Invalid booking management link.")
  }
  if (booking.status === "CANCELED") {
    return { result: { bookingId: booking.id, status: "CANCELED" } }
  }

  if (parsed.action === "cancel") {
    if (booking.providerEventId) {
      await adapter.cancelEvent(booking.providerEventId)
    }
    await db.demoBooking.update({
      where: { id: booking.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    })
    return { result: { bookingId: booking.id, status: "CANCELED" } }
  }

  // Reschedule: confirm the replacement before touching the original.
  const newStart = new Date(parsed.newSlotStart!)
  const newEnd = new Date(newStart.getTime() + D.durationMinutes * 60_000)
  if (!isOnGrid(newStart, newEnd) || newStart.getTime() < Date.now() + D.minNoticeHours * 3_600_000) {
    throw new MyraServiceError("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
  }
  const holdStart = new Date(newStart.getTime() - D.bufferMinutes * 60_000)
  const holdEnd = new Date(newEnd.getTime() + D.bufferMinutes * 60_000)
  if (await overlapsHeld(holdStart, holdEnd, adapter, db, booking.id)) {
    throw new MyraServiceError("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
  }

  const newBookingId = randomUUID()
  const newEventId = `myra-demo-${newBookingId}`
  const newToken = randomBytes(32).toString("base64url")
  await db.demoBooking.create({
    data: {
      id: newBookingId,
      status: "HELD",
      attendeeEmail: booking.attendeeEmail,
      attendeeName: booking.attendeeName,
      attendeeContext: booking.attendeeContext,
      attendeeVerifiedAt: booking.attendeeVerifiedAt,
      startsAt: newStart,
      endsAt: newEnd,
      holdStartsAt: holdStart,
      holdEndsAt: holdEnd,
      timezone: booking.timezone,
      organizerEmail: booking.organizerEmail,
      providerEventId: newEventId,
      manageTokenHash: hashManageToken(newToken),
      idempotencyKey: `resched:${newEventId}`,
      accountId: booking.accountId,
      publicSessionId: booking.publicSessionId,
      conversationId: ctx.conversationId ?? booking.conversationId,
      rescheduledFromId: booking.id,
    },
  })
  try {
    const event = await adapter.insertEvent({
      eventId: newEventId,
      summary: `LyraShield demo — ${booking.attendeeName}`,
      description: booking.attendeeContext ?? undefined,
      start: newStart,
      end: newEnd,
      attendeeEmail: booking.attendeeEmail,
      attendeeName: booking.attendeeName,
      organizerEmail: booking.organizerEmail,
      conferenceRequestId: newBookingId,
      requestMeet: true,
    })
    await db.demoBooking.update({
      where: { id: newBookingId },
      data: {
        status: "CONFIRMED",
        meetLink: event.meetLink,
        conferenceState: event.conferenceState,
      },
    })
  } catch (e) {
    await db.demoBooking.update({
      where: { id: newBookingId },
      data: { status: e instanceof CalendarConflictError ? "CANCELED" : "OUTCOME_UNKNOWN" },
    })
    if (e instanceof CalendarConflictError) {
      throw new MyraServiceError("SLOT_UNAVAILABLE", MYRA_COPY.demoConflict)
    }
    throw new OutcomeUnknownError(MYRA_COPY.demoUnknown)
  }

  // Replacement confirmed — now release the original. A failure here must
  // not fail the operation: the new booking is already valid; the stale
  // original is retried by the retention/reconcile path.
  try {
    if (booking.providerEventId) {
      await adapter.cancelEvent(booking.providerEventId).catch(() => {})
    }
    await db.demoBooking.update({
      where: { id: booking.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    })
  } catch {
    /* best-effort release — the confirmed replacement stands */
  }
  return {
    result: {
      bookingId: newBookingId,
      status: "CONFIRMED",
      startsAt: newStart.toISOString(),
      rescheduledFromId: booking.id,
    },
    privateResult: { manageToken: newToken },
  }
}
