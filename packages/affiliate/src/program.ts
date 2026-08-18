/**
 * Load the active AffiliateProgram (terms). Versioned — for v1 there is a single
 * active program row. The database-architect owns the schema; this module reads
 * the row and exposes a typed terms object.
 */

import { prisma, type AffiliateProgram } from "@lyrashield/db"

export interface AffiliateProgramTerms {
  id: string
  slug: string
  attributionWindowDays: number
  holdDays: number
  capMonths: number
  baseRateBps: number
  tierRateBps: number
  tierThreshold: number
  reservePct: number
  reserveDays: number
  minPayout: /** USD major units as a string to preserve Decimal precision */ string
  currency: string
  active: boolean
}

function toTerms(row: AffiliateProgram): AffiliateProgramTerms {
  return {
    id: row.id,
    slug: row.slug,
    attributionWindowDays: row.attributionWindowDays,
    holdDays: row.holdDays,
    capMonths: row.capMonths,
    baseRateBps: row.baseRateBps,
    tierRateBps: row.tierRateBps,
    tierThreshold: row.tierThreshold,
    reservePct: row.reservePct,
    reserveDays: row.reserveDays,
    minPayout: row.minPayout.toString(),
    currency: row.currency,
    active: row.active,
  }
}

/**
 * Load the active affiliate program by slug (defaults to "default").
 * Returns the first active program if slug is not found.
 * Throws if no active program exists.
 */
export async function loadActiveProgram(slug = "default"): Promise<AffiliateProgramTerms> {
  const row = await prisma.affiliateProgram.findFirst({
    where: { slug, active: true },
  })

  if (row) return toTerms(row)

  // Fallback: any active program
  const fallback = await prisma.affiliateProgram.findFirst({
    where: { active: true },
  })

  if (!fallback) {
    throw new Error(
      `No active AffiliateProgram found (slug="${slug}"). ` +
        "Seed the program row before using the affiliate engine."
    )
  }

  return toTerms(fallback)
}
