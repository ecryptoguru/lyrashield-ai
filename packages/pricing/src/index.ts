/**
 * @lyrashield/pricing — Central pricing catalog for cloud plans, local SKUs,
 * and prepaid minute packs. All amounts are in major currency units (not cents)
 * to avoid floating-point representation issues at the catalog level; convert
 * to integer cents at the billing boundary.
 */

export {
  CLOUD_PLANS,
  CLOUD_PLAN_MAP,
  type CloudPlan,
  type CloudPlanId,
  type PlanPrice,
  type RegionalPrice,
} from "./plans"

export {
  LOCAL_SKUS,
  LOCAL_SKU_MAP,
  type LocalSku,
  type LocalSkuId,
  TEAM_VOLUME_THRESHOLD,
  TEAM_VOLUME_DISCOUNT_PCT,
  qualifiesForTeamVolumeDiscount,
  teamSeatPrice,
  teamOrderTotal,
  teamVolumeDiscountPct,
} from "./local"

export {
  MINUTE_PACKS,
  MINUTE_PACK_MAP,
  STANDARD_OVERAGE_PER_MINUTE_USD,
  DEEP_SCAN_MULTIPLIER,
  PACK_VALIDITY_DAYS,
  type MinutePack as MinutePackSku,
  type PackId,
} from "./packs"

// Webhook payload classification predicates (single source of truth for the
// billing normalizer and the affiliate dispatcher).
export {
  extractProductId,
  isLocalSkuOrderPayload,
  isMinutePackOrderPayload,
} from "./payload-detect"

import { CLOUD_PLAN_MAP, type CloudPlanId } from "./plans"
import { LOCAL_SKU_MAP, type LocalSkuId } from "./local"
import { MINUTE_PACK_MAP, type PackId } from "./packs"

// ─── Lookup helpers ──────────────────────────────────────────────────────────

/** Get a cloud plan by id. Returns `undefined` if the id is not recognised. */
export function getPlan(id: CloudPlanId) {
  return CLOUD_PLAN_MAP[id]
}

/** Get a local SKU by id. Returns `undefined` if the id is not recognised. */
export function getLocalSku(id: LocalSkuId) {
  return LOCAL_SKU_MAP[id]
}

/** Get a minute pack by id. Returns `undefined` if the id is not recognised. */
export function getPack(id: PackId) {
  return MINUTE_PACK_MAP[id]
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

/** Format a number as USD currency, e.g. `formatUSD(29)` → `"$29.00"`. */
export function formatUSD(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

/** Format a number as INR currency, e.g. `formatINR(2900)` → `"₹2,900.00"`. */
export function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}
