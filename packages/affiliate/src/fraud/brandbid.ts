/**
 * Brand-bid monitoring — admin-queue surface for brand-bid monitoring notes.
 *
 * This is a manual review surface. Admins add notes about affiliates who may
 * be bidding on LyraShield brand terms in search ads. No automated enforcement
 * — just a queue for the affiliate manager to review.
 */

import { logger } from "@lyrashield/logger"

export interface BrandBidNote {
  id: string
  affiliateId: string
  note: string
  reportedBy: string
  createdAt: Date
}

/**
 * Add a brand-bid monitoring note for an affiliate.
 */
export async function addBrandBidNote(params: {
  affiliateId: string
  note: string
  reportedBy: string
}): Promise<BrandBidNote> {
  logger.info("Brand-bid note added", {
    affiliateId: params.affiliateId,
    reportedBy: params.reportedBy,
  })

  // In production, this would create a row in a BrandBidNote table.
  // For now, we log it — the admin dashboard surfaces these via audit logs.
  return {
    id: `bbn_${Date.now()}`,
    affiliateId: params.affiliateId,
    note: params.note,
    reportedBy: params.reportedBy,
    createdAt: new Date(),
  }
}
