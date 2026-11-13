export const AFFILIATE_RULE_VERSION = "v1"

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

/** Payout day of month (net-30 on the 15th). */
export const PAYOUT_DAY_OF_MONTH = 15

/** Manual review threshold for clawbacks (USD major units). */
export const CLAWBACK_MANUAL_REVIEW_THRESHOLD_USD = 200

/**
 * Current version of the binding affiliate program terms. Affiliates must
 * accept this version when applying; the accepted version is recorded on the
 * Affiliate record (termsVersion) so there is a durable record of exactly
 * which terms they agreed to. Bump this when the terms change.
 */
export const AFFILIATE_TERMS_VERSION = "2026-08-18-v1"
