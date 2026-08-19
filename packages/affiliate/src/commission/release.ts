/**
 * Commission release — `releaseCommissions()`.
 *
 * PENDING where availableAt <= now and not refunded → AVAILABLE
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export interface ReleaseResult {
  released: number
  commissionIds: string[]
}

/**
 * Release all PENDING commissions whose availableAt has passed.
 * Called by the hourly BullMQ job.
 */
export async function releaseCommissions(): Promise<ReleaseResult> {
  const now = new Date()

  // Find eligible commissions
  const eligible = await prisma.commission.findMany({
    where: {
      status: "PENDING",
      availableAt: { lte: now },
    },
    select: { id: true },
  })

  if (eligible.length === 0) {
    return { released: 0, commissionIds: [] }
  }

  const ids = eligible.map((c) => c.id)

  // Batch update
  const result = await prisma.commission.updateMany({
    where: {
      id: { in: ids },
      status: "PENDING",
    },
    data: { status: "AVAILABLE" },
  })

  logger.info("Commissions released", {
    count: result.count,
    releasedAt: now,
  })

  return {
    released: result.count,
    commissionIds: ids,
  }
}
