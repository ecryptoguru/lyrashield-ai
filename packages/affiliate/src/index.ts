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

export {
  AFFILIATE_RULE_VERSION,
  AFFILIATE_TERMS_VERSION,
  ANNUAL_RATE_BPS,
  BASE_RATE_BPS,
  CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD,
  DEFAULT_CAP_MONTHS,
  DEFAULT_HOLD_DAYS,
  DEFAULT_RESERVE_DAYS,
  DEFAULT_RESERVE_PCT,
  LOCAL_RATE_BPS,
  PAYOUT_DAY_OF_MONTH,
  TIER_RATE_BPS,
  TIER_THRESHOLD,
} from "./constants"

export { loadActiveProgram, type AffiliateProgramTerms } from "./program"

export { detectAttribution, type AttributionDetectionResult } from "./attribution/middleware"

export {
  AFFILIATE_COOKIE_NAME,
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

export { createRazorpayXProvider } from "./payout/providers/razorpayx"
export { createPayoneerProvider } from "./payout/providers/payoneer"

export { detectFraudSignals, type FraudSignal, type FraudResult } from "./fraud/signals"

export { isSelfReferral } from "./fraud/selfreferral"

export { dispatch, type NormalizedEventDispatchInput } from "./webhook-dispatch"
