/**
 * @lyrashield/affiliate — Affiliate & partner program engine.
 *
 * Attribution, commission calculation, clawback, payouts, and fraud signals.
 * All monetary amounts use Prisma Decimal (@db.Decimal(19,4)) — never Float.
 *
 * Commission rules (v1):
 *  - 25% recurring on Cloud subscriptions (12-month cap from first paid)
 *  - 30% recurring once affiliate reaches 10+ active referred subscriptions
 *  - 20% one-time on Local-license one-time Polar orders
 *  - No commission on minute packs, trial signups, or self-referrals
 *  - 30-day hold (PENDING → AVAILABLE), monthly net-30 payout on the 15th
 *  - $100 minimum payout
 *  - New-affiliate reserve: 20-30% held first 90 days
 */

export const AFFILIATE_RULE_VERSION = "v1"

/** Cookie name for the first-party attribution token (random id, NOT a JWT). */
export const AFFILIATE_COOKIE_NAME = "__ls_aff"

/** Default attribution window in days (last-click wins). */
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 60

/** Default hold period in days before a PENDING commission becomes AVAILABLE. */
export const DEFAULT_HOLD_DAYS = 30

/** Commission cap in months from first paid subscription payment. */
export const DEFAULT_CAP_MONTHS = 12

/** Base commission rate in basis points (25%). */
export const BASE_RATE_BPS = 2500

/** Tier commission rate in basis points (30%) at 10+ active referrals. */
export const TIER_RATE_BPS = 3000

/** Active-referral count to unlock the tier rate. */
export const TIER_THRESHOLD = 10

/** Local-license one-time commission rate in basis points (20%). */
export const LOCAL_RATE_BPS = 2000

/** Annual Cloud plan commission rate in basis points (25% of annual amount). */
export const ANNUAL_RATE_BPS = 2500

/** New-affiliate reserve percentage (25%). */
export const DEFAULT_RESERVE_PCT = 25

/** New-affiliate reserve duration in days. */
export const DEFAULT_RESERVE_DAYS = 90

/** Minimum payout amount in USD (major units). */
export const DEFAULT_MIN_PAYOUT_USD = 100

/** Payout day of month (net-30 on the 15th). */
export const PAYOUT_DAY_OF_MONTH = 15

/** Manual review threshold for clawbacks (USD major units). */
export const CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD = 200

/**
 * Current version of the binding affiliate program terms. Affiliates must
 * accept this version when applying; the accepted version is recorded on the
 * Affiliate record (termsVersion) so there is a durable record of exactly
 * which terms an affiliate agreed to. Bump this when the terms change.
 */
export const AFFILIATE_TERMS_VERSION = "2026-08-18-v1"

export { loadActiveProgram, type AffiliateProgramTerms } from "./program"

export { detectAttribution, type AttributionDetectionResult } from "./attribution/middleware"

export {
  buildAffiliateCookie,
  parseAffiliateCookie,
  AFFILIATE_COOKIE_MAX_AGE,
  type AffiliateCookieOptions,
} from "./attribution/cookie"

export {
  resolveAttribution,
  type AttributionResolution,
  type AttributionMethod,
} from "./attribution/resolve"

export { attributeSignup, type SignupAttributionInput } from "./attribution/signup"

export { persistCrossDeviceAttribution } from "./attribution/cross-device"

export { onOrderPaid, type OrderPaidPayload, type OrderPaidResult } from "./commission/engine"

export { onRefund, type RefundPayload, type ClawbackReason } from "./commission/clawback"

export { releaseCommissions, type ReleaseResult } from "./commission/release"

export { onLocalOrderPaid, type LocalOrderPaidPayload } from "./commission/local"

export { expireAttributionTokens, type ExpireResult } from "./commission/expire"

export { checkPayoutEligibility, type PayoutEligibility } from "./payout/eligibility"

export { computeReserve, isReserveActive, setupReserve, type ReserveInfo } from "./payout/reserve"
export {
  releaseReserve,
  releaseReserveForAffiliate,
  type ReserveReleaseResult,
} from "./payout/reserve-release"

export { requestPayout, type PayoutRequestResult } from "./payout/request"

export { payoutScheduler, type PayoutBatch } from "./payout/scheduler"

export { reconciliationJob, type ReconciliationResult } from "./payout/reconciliation"

export { createRazorpayXProvider } from "./payout/providers/razorpayx"
export { createPayoneerProvider } from "./payout/providers/payoneer"
export { createBriskpeProvider } from "./payout/providers/briskpe"
export { createTrolleyProvider } from "./payout/providers/trolley"

export { detectFraudSignals, type FraudSignal, type FraudResult } from "./fraud/signals"

export { isSelfReferral } from "./fraud/selfreferral"

export { dispatch, type NormalizedEventDispatchInput } from "./webhook-dispatch"
