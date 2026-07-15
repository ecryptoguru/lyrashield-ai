import { LITE_CHECK_VERSION } from "./lite-scan"

export const LITE_SCORECARD_PAYLOAD_VERSION = 1 as const

export type LiteScorecardPayload = {
  kind: "lite-check"
  payloadVersion: typeof LITE_SCORECARD_PAYLOAD_VERSION
  checkVersion: typeof LITE_CHECK_VERSION
  generatedAt: string
  needsAttention: number
  worthReviewing: number
  looksOk: number
  referralCode?: string
}

type LiteScorecardInput = {
  needsAttention: number
  worthReviewing: number
  looksOk: number
  referralCode?: string
  generatedAt?: string
}

function safeCount(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 50) {
    throw new Error("Lite scorecard counts must be integers between 0 and 50")
  }
  return value
}

/**
 * The only constructor for a public Lite Check payload.
 *
 * This deliberately accepts only aggregate counters, a version, a timestamp,
 * and an optional waitlist referral code. Target URLs, findings, evidence,
 * secret matches, headers, and free-form text have no path into the payload.
 */
export function buildLiteScorecardPayload(input: LiteScorecardInput): LiteScorecardPayload {
  const referralCode = input.referralCode?.toUpperCase()
  if (referralCode && !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(referralCode)) {
    throw new Error("Invalid Lite scorecard referral code")
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("Invalid Lite scorecard timestamp")

  return Object.freeze({
    kind: "lite-check",
    payloadVersion: LITE_SCORECARD_PAYLOAD_VERSION,
    checkVersion: LITE_CHECK_VERSION,
    generatedAt,
    needsAttention: safeCount(input.needsAttention),
    worthReviewing: safeCount(input.worthReviewing),
    looksOk: safeCount(input.looksOk),
    ...(referralCode ? { referralCode } : {}),
  })
}
