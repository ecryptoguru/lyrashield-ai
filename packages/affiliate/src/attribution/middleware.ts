/**
 * Attribution detection middleware logic.
 *
 * Detects `?ref=CODE` or `/r/:code` → validates the AffiliateLink +
 * affiliate.status === APPROVED → creates a Click (async, non-blocking) →
 * sets first-party cookie `__ls_aff` (random token id) → creates
 * AttributionToken { tokenHash, affiliateId, clickId, expiresAt: now+60d }.
 *
 * This module is framework-agnostic. The Next.js middleware / route handler
 * calls `detectAttribution()` with the request context.
 */

import { randomUUID, createHash } from "node:crypto"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { loadActiveProgram } from "../program"
import { buildAffiliateCookie } from "./cookie"

export interface AttributionDetectionResult {
  /** Whether an affiliate attribution was detected and recorded. */
  attributed: boolean
  /** The opaque token to set in the cookie (if attributed). */
  token?: string
  /** The Set-Cookie header string (if attributed). */
  setCookie?: string
  /** The affiliate id (if attributed). */
  affiliateId?: string
  /** The click id (if attributed). */
  clickId?: string
  /** The destination URL to redirect to (for /r/:code). */
  redirectUrl?: string
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Extract the referral code from either `?ref=CODE` or a `/r/:code` path.
 */
export function extractRefCode(
  pathname: string,
  searchParams: URLSearchParams
): string | null {
  // ?ref=CODE takes precedence
  const refParam = searchParams.get("ref")
  if (refParam) return refParam.trim()

  // /r/:code path
  const match = /^\/r\/([A-Za-z0-9_-]+)$/.exec(pathname)
  if (match && match[1]) return match[1]

  return null
}

/**
 * Detect attribution from a request. Validates the affiliate link, creates a
 * Click + AttributionToken, and returns the cookie header to set.
 *
 * This is non-blocking: if click creation fails, we log but do not throw —
 * the user should still reach the destination page.
 */
export async function detectAttribution(params: {
  pathname: string
  searchParams: URLSearchParams
  landingUrl?: string
  referrer?: string
  ipHash?: string
  userAgent?: string
  visitorId?: string
  cookieToken?: string | null
  consentGiven?: boolean
}): Promise<AttributionDetectionResult> {
  const {
    pathname,
    searchParams,
    landingUrl,
    referrer,
    ipHash,
    userAgent,
    visitorId,
    consentGiven = true,
  } = params

  const code = extractRefCode(pathname, searchParams)
  if (!code) return { attributed: false }

  // For /r/:code, redirect to the homepage (or a configured destination)
  const isShortLink = /^\/r\//.test(pathname)
  const redirectUrl = isShortLink ? "/" : undefined

  // Validate the affiliate link
  const link = await prisma.affiliateLink.findUnique({
    where: { code },
    include: { affiliate: true },
  })

  if (!link || !link.affiliate) {
    logger.warn("Attribution: affiliate link not found", { code })
    return { attributed: false, redirectUrl }
  }

  if (link.affiliate.status !== "APPROVED") {
    logger.warn("Attribution: affiliate not approved", {
      code,
      status: link.affiliate.status,
    })
    return { attributed: false, redirectUrl }
  }

  // Load program terms for the attribution window
  let windowDays = env.AFFILIATE_ATTRIBUTION_WINDOW_DAYS
  try {
    const terms = await loadActiveProgram(env.AFFILIATE_DEFAULT_PROGRAM_SLUG)
    windowDays = terms.attributionWindowDays
  } catch {
    // Fall back to env default
  }

  // Create the Click (non-blocking — swallow errors)
  let clickId: string | undefined
  try {
    // S4: Hash the user-agent before storing — never store plaintext UA
    const hashedUserAgent = userAgent
      ? createHash("sha256").update(userAgent).digest("hex")
      : null

    const click = await prisma.click.create({
      data: {
        linkId: link.id,
        affiliateId: link.affiliateId,
        visitorId: visitorId ?? null,
        landingUrl: landingUrl ?? null,
        referrer: referrer ?? null,
        ipHash: ipHash ?? null,
        userAgent: hashedUserAgent,
        subid: link.subid ?? null,
        utm: {
          source: searchParams.get("utm_source") ?? null,
          medium: searchParams.get("utm_medium") ?? null,
          campaign: searchParams.get("utm_campaign") ?? null,
          content: searchParams.get("utm_content") ?? null,
          term: searchParams.get("utm_term") ?? null,
        },
      },
    })
    clickId = click.id
  } catch (error) {
    logger.error("Attribution: failed to create click (non-blocking)", {
      code,
      error: error instanceof Error ? error.message : String(error),
    })
    // Still redirect for /r/:code even if click fails
    return { attributed: false, redirectUrl }
  }

  // Only set cookie if consent given
  if (!consentGiven) {
    return {
      attributed: true,
      affiliateId: link.affiliateId,
      clickId,
      redirectUrl,
    }
  }

  // Generate opaque token + create AttributionToken
  const token = randomUUID()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000)

  try {
    await prisma.attributionToken.create({
      data: {
        tokenHash,
        affiliateId: link.affiliateId,
        clickId: clickId!,
        linkId: link.id,
        expiresAt,
      },
    })
  } catch (error) {
    logger.error("Attribution: failed to create attribution token", {
      code,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      attributed: true,
      affiliateId: link.affiliateId,
      clickId,
      redirectUrl,
    }
  }

  const setCookie = buildAffiliateCookie(token)

  return {
    attributed: true,
    token,
    setCookie,
    affiliateId: link.affiliateId,
    clickId,
    redirectUrl,
  }
}
