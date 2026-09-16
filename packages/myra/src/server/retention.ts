/**
 * Retention sweep — founder-resolved periods: conversations 30d (cascade
 * messages + flow sessions), support cases 1y, demo bookings 1y, audit
 * events 90d; expired public sessions and stale identity verifications are
 * removed too.
 */
import { Prisma, prisma } from "@lyrashield/db"
import { MYRA_LIMITS } from "../contracts"
import type { MyraDb } from "./db"

export interface RetentionCounts {
  conversations: number
  publicSessions: number
  verifications: number
  supportCases: number
  demoBookings: number
  operations: number
  auditEvents: number
  generationReservations: number
}

export async function pruneMyraRetention(db: MyraDb = prisma): Promise<RetentionCounts> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const caseCutoff = new Date(now.getTime() - MYRA_LIMITS.caseRetentionDays * 86_400_000)
  const bookingCutoff = new Date(now.getTime() - MYRA_LIMITS.bookingRetentionDays * 86_400_000)
  const opCutoff = new Date(now.getTime() - MYRA_LIMITS.conversationRetentionDays * 86_400_000)
  const auditCutoff = new Date(now.getTime() - MYRA_LIMITS.auditRetentionDays * 86_400_000)

  // Expire pending confirmations past their TTL and fail EXECUTING rows
  // wedged by a crashed process — otherwise both would linger forever.
  await db.myraOperation.updateMany({
    where: { status: "AWAITING_CONFIRMATION", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  })
  await db.myraOperation.updateMany({
    where: { status: "EXECUTING", updatedAt: { lt: dayAgo } },
    data: { status: "FAILED", error: "Execution did not finish." },
  })
  // A HELD booking that never resolved (process died between hold and
  // insert) keeps holding its slot. Move it to OUTCOME_UNKNOWN — the
  // deterministic provider event id lets reconcile sort out what happened.
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  await db.demoBooking.updateMany({
    where: { status: "HELD", createdAt: { lt: hourAgo } },
    data: { status: "OUTCOME_UNKNOWN" },
  })
  // A crashed process may have reached the provider before settlement. Count
  // stale reservations at their conservative ceiling instead of reopening
  // budget that may already have been spent.
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
  }
}
