/**
 * Attribution on signup.
 *
 * On signup: cookie → token → click → affiliate; reject self-referral
 * (affiliate.userId == new userId); persist ruleVersion="v1".
 *
 * This creates a pending attribution link between the new user and the
 * affiliate. The actual commission is created when the referred user pays.
 */

import { createHash } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { isSelfReferral } from "../fraud/selfreferral"
import { AFFILIATE_RULE_VERSION } from "../index"

export interface SignupAttributionInput {
  /** The newly created user id. */
  userId: string
  /** The opaque cookie token (if present). */
  cookieToken?: string | null
  /** A promo code entered at signup (if any). */
  promoCode?: string | null
}

export interface SignupAttributionResult {
  attributed: boolean
  affiliateId?: string
  /** Whether attribution was rejected due to self-referral. */
  rejectedSelfReferral?: boolean
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Attribute a signup to an affiliate.
 * Resolves attribution via promo code or cookie, rejects self-referrals,
 * and marks the attribution token as consumed.
 */
export async function attributeSignup(
  input: SignupAttributionInput
): Promise<SignupAttributionResult> {
  const { userId, cookieToken, promoCode } = input

  // 1. Try promo code first
  if (promoCode) {
    const affiliate = await prisma.affiliate.findUnique({
      where: { promoCode },
      select: { id: true, userId: true, status: true },
    })

    if (affiliate && affiliate.status === "APPROVED") {
      // Reject self-referral
      if (isSelfReferral(affiliate.userId, userId)) {
        logger.warn("Signup attribution: self-referral rejected (promo code)", {
          affiliateId: affiliate.id,
          userId,
        })
        return { attributed: false, rejectedSelfReferral: true }
      }

      // Persist attribution link on the user (via relation)
      await prisma.user.update({
        where: { id: userId },
        data: { affiliate: { connect: { id: affiliate.id } } },
      })

      logger.info("Signup attributed via promo code", {
        affiliateId: affiliate.id,
        userId,
        ruleVersion: AFFILIATE_RULE_VERSION,
      })

      return { attributed: true, affiliateId: affiliate.id }
    }
  }

  // 2. Try cookie token
  if (cookieToken) {
    const tokenHash = hashToken(cookieToken)
    const token = await prisma.attributionToken.findUnique({
      where: { tokenHash },
      include: {
        affiliate: { select: { id: true, userId: true, status: true } },
      },
    })

    if (
      token &&
      !token.consumed &&
      token.expiresAt > new Date() &&
      token.affiliate.status === "APPROVED"
    ) {
      // Reject self-referral
      if (isSelfReferral(token.affiliate.userId, userId)) {
        logger.warn("Signup attribution: self-referral rejected (cookie)", {
          affiliateId: token.affiliateId,
          userId,
        })
        // Mark token consumed so it can't be reused
        await prisma.attributionToken.update({
          where: { id: token.id },
          data: { consumed: true },
        })
        return { attributed: false, rejectedSelfReferral: true }
      }

      // Persist attribution link on the user (via relation)
      await prisma.user.update({
        where: { id: userId },
        data: { affiliate: { connect: { id: token.affiliateId } } },
      })

      // Mark token consumed
      await prisma.attributionToken.update({
        where: { id: token.id },
        data: { consumed: true },
      })

      logger.info("Signup attributed via cookie", {
        affiliateId: token.affiliateId,
        userId,
        ruleVersion: AFFILIATE_RULE_VERSION,
      })

      return { attributed: true, affiliateId: token.affiliateId }
    }
  }

  // 3. Unattributed
  return { attributed: false }
}
