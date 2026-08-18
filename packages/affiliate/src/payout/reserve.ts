/**
 * New-affiliate reserve.
 *
 * 20-30% held first 90 days; released as they prove out.
 * Visible in dashboard.
 */

import { prisma } from "@lyrashield/db"
import { DEFAULT_RESERVE_PCT, DEFAULT_RESERVE_DAYS } from "../index"

export interface ReserveInfo {
  /** Whether the reserve is currently active. */
  active: boolean
  /** Reserve percentage (20-30). */
  pct: number
  /** When the reserve period ends. */
  until: Date | null
  /** Days remaining in the reserve period. */
  daysRemaining: number
}

/**
 * Compute whether the new-affiliate reserve is active for a given affiliate.
 */
export function computeReserve(params: {
  reservePct: number
  reserveUntil: Date | null
  now?: Date
}): ReserveInfo {
  const now = params.now ?? new Date()
  const until = params.reserveUntil
  const active = until ? until > now : false
  const daysRemaining = active && until
    ? Math.ceil((until.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    : 0

  return {
    active,
    pct: params.reservePct,
    until,
    daysRemaining,
  }
}

/**
 * Check if the reserve is active for an affiliate.
 */
export function isReserveActive(reserveUntil: Date | null, now?: Date): boolean {
  const checkTime = now ?? new Date()
  return reserveUntil ? reserveUntil > checkTime : false
}

/**
 * Set up the new-affiliate reserve when an affiliate is approved.
 * Uses the program's reservePct and reserveDays.
 */
export async function setupReserve(
  affiliateId: string,
  reservePct: number = DEFAULT_RESERVE_PCT,
  reserveDays: number = DEFAULT_RESERVE_DAYS
): Promise<void> {
  const until = new Date(Date.now() + reserveDays * 24 * 60 * 60 * 1000)

  await prisma.affiliate.update({
    where: { id: affiliateId },
    data: {
      reservePct,
      reserveUntil: until,
    },
  })
}
