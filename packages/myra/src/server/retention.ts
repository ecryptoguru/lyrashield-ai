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
  pendingProviderCancellations: number
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
 * non-fatal: the row is marked CANCELED so the slot unblocks and the token
 * dies, while providerEventId remains a durable cleanup obligation.
 */
interface ProviderCancellation {
  id: string
  providerEventId: string
}

async function reconcileRescheduledOriginals(
  db: MyraDb
): Promise<{ count: number; cancellations: ProviderCancellation[] }> {
  // Bound outstanding work, not historical replacements. Selecting the first
  // 100 replacement rows would revisit already-canceled originals forever and
  // starve later bookings. EXISTS preserves the reschedule link while limiting
  // each sweep to originals that still need reconciliation.
  const stale = await db.$queryRaw<Array<{ id: string; providerEventId: string | null }>>(
    Prisma.sql`
      SELECT original.id, original."providerEventId"
      FROM "demo_bookings" AS original
      WHERE original.status IN ('CONFIRMED', 'HELD')
        AND EXISTS (
          SELECT 1
          FROM "demo_bookings" AS replacement
          WHERE replacement."rescheduledFromId" = original.id
            AND replacement.status = 'CONFIRMED'
        )
      ORDER BY original."createdAt" ASC, original.id ASC
      LIMIT 100
    `
  )
  const now = new Date()
  for (const original of stale) {
    await db.demoBooking.update({
      where: { id: original.id },
      data: {
        status: "CANCELED",
        canceledAt: now,
        manageTokenHash: null,
        manageTokenRevokedAt: now,
        providerEventId: original.providerEventId,
      },
    })
  }
  return {
    count: stale.length,
    cancellations: stale.flatMap(({ id, providerEventId }) =>
      providerEventId ? [{ id, providerEventId }] : []
    ),
  }
}

/** Find calendar cleanup retained after cancellation or account erasure. */
async function findPendingProviderCancellations(
  db: MyraDb,
  now: Date
): Promise<ProviderCancellation[]> {
  return db.demoBooking
    .findMany({
      where: {
        status: "CANCELED",
        providerEventId: { not: null },
        canceledAt: { lt: new Date(now.getTime() - 60_000) },
      },
      select: { id: true, providerEventId: true },
      take: 100,
    })
    .then((bookings) =>
      bookings.flatMap(({ id, providerEventId }) =>
        providerEventId ? [{ id, providerEventId }] : []
      )
    )
}

async function pruneRetentionRows(db: MyraDb): Promise<{
  counts: RetentionCounts
  cancellations: ProviderCancellation[]
}> {
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

  const rescheduled = await reconcileRescheduledOriginals(db)
  const pending = await findPendingProviderCancellations(db, now)

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
    db.demoBooking.deleteMany({
      where: {
        createdAt: { lt: bookingCutoff },
        OR: [{ status: { not: "CANCELED" } }, { providerEventId: null }],
      },
    }),
    db.myraOperation.deleteMany({
      where: {
        status: { in: ["EXPIRED", "CANCELED", "FAILED"] },
        updatedAt: { lt: opCutoff },
      },
    }),
    db.myraAuditEvent.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
  ])
  return {
    counts: {
      conversations: conversations.count,
      publicSessions: publicSessions.count,
      verifications: verifications.count,
      supportCases: supportCases.count,
      demoBookings: demoBookings.count,
      operations: operations.count,
      auditEvents: auditEvents.count,
      generationReservations: generationReservationCount,
      rescheduledOriginals: rescheduled.count,
      pendingProviderCancellations: pending.length,
    },
    cancellations: [...rescheduled.cancellations, ...pending],
  }
}

export async function pruneMyraRetention(
  db: MyraDb = prisma,
  adapter: CalendarAdapter = getCalendarAdapter()
): Promise<RetentionCounts> {
  // Commit cross-owner retention before making bounded provider calls. Each
  // successful provider cancellation is then acknowledged in a short write.
  const result =
    db === prisma
      ? await withMyraOperatorRLS(MYRA_TRUSTED_RETENTION, (tx) => pruneRetentionRows(tx))
      : await pruneRetentionRows(db)

  for (const cancellation of result.cancellations) {
    try {
      await adapter.cancelEvent(cancellation.providerEventId)
      const acknowledge = (scopedDb: MyraDb) =>
        scopedDb.demoBooking.updateMany({
          where: {
            id: cancellation.id,
            status: "CANCELED",
            providerEventId: cancellation.providerEventId,
          },
          data: { providerEventId: null },
        })
      if (db === prisma) {
        await withMyraOperatorRLS(MYRA_TRUSTED_RETENTION, acknowledge)
      } else {
        await acknowledge(db)
      }
    } catch {
      // Keep providerEventId so the next bounded pass retries it.
    }
  }

  return result.counts
}
