/**
 * Cross-device attribution.
 *
 * If a user signs up authenticated after a click on another device, persist
 * the affiliate↔user link. This handles the case where a user clicks an
 * affiliate link on one device, creates an account later on another device,
 * and then authenticates — the attribution is linked at that point.
 */

import { createHash } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { isSelfReferral } from "../fraud/selfreferral"

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Persist cross-device attribution when a user authenticates and has an
 * attribution cookie that hasn't been linked to their account yet.
 *
 * Only links if the user doesn't already have an affiliate attribution.
 */
export async function persistCrossDeviceAttribution(params: {
  userId: string
  cookieToken?: string | null
}): Promise<{ attributed: boolean; affiliateId?: string }> {
  const { userId, cookieToken } = params

  if (!cookieToken) return { attributed: false }

  // Check if user already has attribution
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { affiliate: { select: { id: true } } },
  })

  if (existingUser?.affiliate) {
    // Already attributed — don't override
    return { attributed: false }
  }

  const tokenHash = hashToken(cookieToken)
  const token = await prisma.attributionToken.findUnique({
    where: { tokenHash },
    include: {
      affiliate: { select: { id: true, userId: true, status: true } },
    },
  })

  if (
    !token ||
    token.consumed ||
    token.expiresAt <= new Date() ||
    token.affiliate.status !== "APPROVED"
  ) {
    return { attributed: false }
  }

  // Reject self-referral
  if (isSelfReferral(token.affiliate.userId, userId)) {
    logger.warn("Cross-device attribution: self-referral rejected", {
      affiliateId: token.affiliateId,
      userId,
    })
    await prisma.attributionToken.update({
      where: { id: token.id },
      data: { consumed: true },
    })
    return { attributed: false }
  }

  // Persist attribution link (via relation)
  await prisma.user.update({
    where: { id: userId },
    data: { affiliate: { connect: { id: token.affiliateId } } },
  })

  // Mark token consumed
  await prisma.attributionToken.update({
    where: { id: token.id },
    data: { consumed: true },
  })

  logger.info("Cross-device attribution persisted", {
    affiliateId: token.affiliateId,
    userId,
  })

  return { attributed: true, affiliateId: token.affiliateId }
}
