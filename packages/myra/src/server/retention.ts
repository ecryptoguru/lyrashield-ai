/**
 * Retention sweep — founder-resolved periods: conversations 30d (cascade
 * messages + flow sessions), support cases 1y, demo bookings 1y; expired
 * public sessions and stale identity verifications are removed too.
 */
import { prisma } from "@lyrashield/db"
import { MYRA_LIMITS } from "../contracts"
import type { MyraDb } from "./db"

export interface RetentionCounts {
  conversations: number
  publicSessions: number
  verifications: number
  supportCases: number
  demoBookings: number
  operations: number
}

export async function pruneMyraRetention(db: MyraDb = prisma): Promise<RetentionCounts> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const caseCutoff = new Date(now.getTime() - MYRA_LIMITS.caseRetentionDays * 86_400_000)
  const bookingCutoff = new Date(now.getTime() - MYRA_LIMITS.bookingRetentionDays * 86_400_000)
  const opCutoff = new Date(now.getTime() - MYRA_LIMITS.conversationRetentionDays * 86_400_000)

  const [conversations, publicSessions, verifications, supportCases, demoBookings, operations] =
    await Promise.all([
      db.myraConversation.deleteMany({ where: { expiresAt: { lt: now } } }),
      db.myraPublicSession.deleteMany({ where: { expiresAt: { lt: now } } }),
      db.myraIdentityVerification.deleteMany({
        where: {
          OR: [
            { consumedAt: { lt: dayAgo } },
            { consumedAt: null, expiresAt: { lt: dayAgo } },
          ],
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
    ])
  return {
    conversations: conversations.count,
    publicSessions: publicSessions.count,
    verifications: verifications.count,
    supportCases: supportCases.count,
    demoBookings: demoBookings.count,
    operations: operations.count,
  }
}
