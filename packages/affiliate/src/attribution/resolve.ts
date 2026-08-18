/**
 * Attribution resolution at checkout/signup.
 *
 * Precedence:
 *  1. Valid affiliate promo code at checkout → code owner
 *  2. Else valid unexpired last-click cookie → its affiliate
 *  3. Else unattributed
 */

import { createHash } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"

export type AttributionMethod = "promo_code" | "cookie" | "unattributed"

export interface AttributionResolution {
  method: AttributionMethod
  affiliateId: string | null
  /** The AttributionToken id if resolved via cookie. */
  tokenId?: string
  /** The click id if resolved via cookie. */
  clickId?: string
  /** The link id if resolved via cookie. */
  linkId?: string
  /** The subid if available. */
  subid?: string | null
  /** The promo code if resolved via promo code. */
  promoCode?: string
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Resolve attribution given a promo code and/or cookie token.
 * Promo code takes precedence over cookie.
 */
export async function resolveAttribution(params: {
  promoCode?: string | null
  cookieToken?: string | null
}): Promise<AttributionResolution> {
  const { promoCode, cookieToken } = params

  // 1. Promo code → code owner
  if (promoCode) {
    const affiliate = await prisma.affiliate.findUnique({
      where: { promoCode },
      select: { id: true, status: true, promoCode: true },
    })

    if (affiliate && affiliate.status === "APPROVED") {
      return {
        method: "promo_code",
        affiliateId: affiliate.id,
        promoCode: affiliate.promoCode ?? undefined,
      }
    }

    // Invalid promo code — log but fall through to cookie
    logger.warn("Attribution: promo code not found or not approved", { promoCode })
  }

  // 2. Cookie → last-click affiliate
  if (cookieToken) {
    const tokenHash = hashToken(cookieToken)
    const token = await prisma.attributionToken.findUnique({
      where: { tokenHash },
      include: {
        affiliate: { select: { id: true, status: true } },
        click: { select: { subid: true } },
      },
    })

    if (
      token &&
      !token.consumed &&
      token.expiresAt > new Date() &&
      token.affiliate.status === "APPROVED"
    ) {
      return {
        method: "cookie",
        affiliateId: token.affiliateId,
        tokenId: token.id,
        clickId: token.clickId,
        linkId: token.linkId,
        subid: token.click?.subid ?? null,
      }
    }

    // Cookie expired or invalid — fall through
    if (token?.consumed) {
      logger.debug("Attribution: cookie token already consumed")
    } else if (token && token.expiresAt <= new Date()) {
      logger.debug("Attribution: cookie token expired")
    }
  }

  // 3. Unattributed
  return {
    method: "unattributed",
    affiliateId: null,
  }
}
