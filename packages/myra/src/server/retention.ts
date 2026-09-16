/**
 * Retention sweep — founder-resolved periods: conversations 30d (cascade
 * messages + flow sessions), support cases 1y, demo bookings 1y, audit
 * events 90d; expired public sessions and stale identity verifications are
 * removed too. The sweep also reconciles bookings superseded by a confirmed
 * reschedule — their provider events would otherwise stay live forever.
 */
import { Prisma, prisma, withMyraOperatorRLS } from "@lyrashield/db"
import { MYRA_LIMITS } from "../contracts"
import { getCalendarAdapter, type CalendarAdapter } from "./calendar/adapter"
import { MYRA_TRUSTED_RETENTION, type MyraDb } from "./db"

export interface RetentionCounts {
  conversations: number
  publicSessions: number
  verifications: number
  supportCases: number
  demoBookings: number
  operations: number
  auditEvents: number
  generationReservations: number
  rescheduledOriginals: number
}

export interface RecoveryCounts {
  wedgedOperations: number
  heldBookings: number
}

/**
 * Fast recovery pass — the two wedged-state repairs that hold user-facing
 * resources and so keep a short worker cadence. EXECUTING rows wedged by a
 * crashed process are failed (the proposal can then be re-prepared) and a
 * HELD booking that never resolved is moved to OUTCOME_UNKNOWN so its slot
 * unblocks — the deterministic provider event id lets reconcile sort out
 * what happened.
 */
export async function recoverMyraState(db: MyraDb = prisma): Promise<RecoveryCounts> {
  // Same trusted-path binding as the retention sweep — the recovery runner
  // is the authorization and the sentinel declares the path (v18 1.3).
  if (db === prisma) {
    return withMyraOperatorRLS(MYRA_TRUSTED_RETENTION, (tx) => recoverMyraState(tx))
  }
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const [wedged, held] = await Promise.all([
    db.myraOperation.updateMany({
      where: { status: "EXECUTING", updatedAt: { lt: dayAgo } },
      data: { status: "FAILED", error: "Execution did not finish." },
    }),
    db.demoBooking.updateMany({
      where: { status: "HELD", createdAt: { lt: hourAgo } },
      data: { status: "OUTCOME_UNKNOWN" },
    }),
  ])
  return { wedgedOperations: wedged.count, heldBookings: held.count }
}

/**
 * Cancel the provider event and revoke the manage token of every CONFIRMED
 * or HELD booking already superseded by a CONFIRMED replacement. The
 * reschedule executor releases the original best-effort; a crash between
 * confirming the replacement and that release leaves the original live —
 * this is the retry path its comment references. Provider failures stay
 * non-fatal: the row is still marked CANCELED so the slot unblocks and the
 * token dies.
 */
async function reconcileRescheduledOriginals(
  db: MyraDb,
  adapter: CalendarAdapter
): Promise<number> {
  const replacements = await db.demoBooking.findMany({
    where: { status: "CONFIRMED", rescheduledFromId: { not: null } },
    select: { rescheduledFromId: true },
  })
  const originalIds = [
    ...new Set(
      replacements
        .map((r) => r.rescheduledFromId)
        .filter((id): id is string => typeof id === "string")
    ),
  ]
  if (originalIds.length === 0) return 0
  const stale = await db.demoBooking.findMany({
    where: { id: { in: originalIds }, status: { in: ["CONFIRMED", "HELD"] } },
    select: { id: true, providerEventId: true },
  })
  const now = new Date()
  for (const original of stale) {
    if (original.providerEventId) {
      await adapter.cancelEvent(original.providerEventId).catch(() => {})
    }
    await db.demoBooking.update({
      where: { id: original.id },
      data: {
        status: "CANCELED",
        canceledAt: now,
        manageTokenHash: null,
        manageTokenRevokedAt: now,
      },
    })
  }
  return stale.length
}

export async function pruneMyraRetention(
  db: MyraDb = prisma,
  adapter: CalendarAdapter = getCalendarAdapter()
): Promise<RetentionCounts> {
  // The sweep is trusted-path work: it touches every owner's rows. The
  // dual-owner RESTRICTIVE boundary (v18 1.3) denies context-free statements,
  // so an ambient `db` runs through the retention sentinel — the scheduler
  // caller is the authorization, the binding declares the path.
  if (db === prisma) {
    return withMyraOperatorRLS(MYRA_TRUSTED_RETENTION, (tx) => pruneMyraRetention(tx, adapter))
  }
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const caseCutoff = new Date(now.getTime() - MYRA_LIMITS.caseRetentionDays * 86_400_000)
  const bookingCutoff = new Date(now.getTime() - MYRA_LIMITS.bookingRetentionDays * 86_400_000)
  const opCutoff = new Date(now.getTime() - MYRA_LIMITS.conversationRetentionDays * 86_400_000)
  const auditCutoff = new Date(now.getTime() - MYRA_LIMITS.auditRetentionDays * 86_400_000)

  // Expire pending confirmations past their TTL — bookkeeping only, since
  // confirm() re-checks expiresAt before executing.
  await db.myraOperation.updateMany({
    where: { status: "AWAITING_CONFIRMATION", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  })
  // A crashed process may have reached the provider before settlement. Count
  // stale reservations at their conservative ceiling instead of reopening
  // budget that may already have been spent.
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const generationReservationCount = await db.$executeRaw(
    Prisma.sql`
      UPDATE "myra_generation_reservations"
      SET "status" = 'SETTLED',
          "actualUsd" = "reservedUsd",
          "reservedUsd" = 0,
          "settledAt" = ${now}
      WHERE "status" = 'RESERVED' AND "createdAt" < ${hourAgo}
    `
  )

  const rescheduledOriginals = await reconcileRescheduledOriginals(db, adapter)

  const [
    conversations,
    publicSessions,
    verifications,
    supportCases,
    demoBookings,
    operations,
    auditEvents,
  ] = await Promise.all([
    db.myraConversation.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.myraPublicSession.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.myraIdentityVerification.deleteMany({
      where: {
        OR: [{ consumedAt: { lt: dayAgo } }, { consumedAt: null, expiresAt: { lt: dayAgo } }],
      },
    }),
    db.supportCase.deleteMany({ where: { createdAt: { lt: caseCutoff } } }),
    db.demoBooking.deleteMany({ where: { createdAt: { lt: bookingCutoff } } }),
    db.myraOperation.deleteMany({
      where: {
        status: { in: ["EXPIRED", "CANCELED", "FAILED"] },
        updatedAt: { lt: opCutoff },
      },
    }),
    db.myraAuditEvent.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
  ])
  return {
    conversations: conversations.count,
    publicSessions: publicSessions.count,
    verifications: verifications.count,
    supportCases: supportCases.count,
    demoBookings: demoBookings.count,
    operations: operations.count,
    auditEvents: auditEvents.count,
    generationReservations: generationReservationCount,
    rescheduledOriginals,
  }
}
