/**
 * Local / self-hosted SKU definitions.
 *
 * These are one-time or per-seat purchases for the downloadable LyraShield
 * CLI/agent. They are distinct from cloud subscriptions and minute packs.
 */

export type LocalSkuId =
  | "individual_launch"
  | "individual_regular"
  | "team_perpetual"
  | "team_subscription"
  | "renewal"
  | "sync_addon"

export interface LocalSku {
  id: LocalSkuId
  name: string
  description: string
  /** Price in USD (major units). */
  priceUsd: number
  /** Published India price in INR major units when available. */
  priceInr?: number
  /** Billing period: "one_time", "per_seat", "per_seat_year". */
  billing: "one_time" | "per_seat" | "per_seat_year"
  /** Whether this SKU includes update eligibility. */
  includesUpdates: boolean
  /** Update eligibility duration in days (null = perpetual). */
  updateDays: number | null
}

export const LOCAL_SKUS: readonly LocalSku[] = [
  {
    id: "individual_launch",
    name: "Individual — Launch",
    description: "Single-user perpetual license at launch pricing.",
    priceUsd: 199,
    priceInr: 19_900,
    billing: "one_time",
    includesUpdates: true,
    updateDays: 365,
  },
  {
    id: "individual_regular",
    name: "Individual — Regular",
    description: "Single-user perpetual license at standard pricing.",
    priceUsd: 299,
    billing: "one_time",
    includesUpdates: true,
    updateDays: 365,
  },
  {
    id: "team_perpetual",
    name: "Team — Perpetual",
    description: "Per-seat perpetual license for teams.",
    priceUsd: 99,
    billing: "per_seat",
    includesUpdates: true,
    updateDays: 365,
  },
  {
    id: "team_subscription",
    name: "Team — Subscription",
    description: "Per-seat annual subscription with continuous updates.",
    priceUsd: 149,
    billing: "per_seat_year",
    includesUpdates: true,
    updateDays: 365,
  },
  {
    id: "renewal",
    name: "Update Renewal",
    description: "Annual update renewal per seat.",
    priceUsd: 59,
    billing: "per_seat_year",
    includesUpdates: true,
    updateDays: 365,
  },
  {
    id: "sync_addon",
    name: "Cloud Sync Add-on",
    description: "Annual cloud sync add-on for findings and evidence.",
    priceUsd: 49,
    billing: "per_seat_year",
    includesUpdates: true,
    updateDays: 365,
  },
] as const

/** Map of SKU id → LocalSku for O(1) lookup. */
export const LOCAL_SKU_MAP: Readonly<Record<LocalSkuId, LocalSku>> = Object.fromEntries(
  LOCAL_SKUS.map((s) => [s.id, s])
) as Readonly<Record<LocalSkuId, LocalSku>>

/**
 * Volume-pricing tier for team SKUs.
 *
 * The founder-confirmed spec gives teams 10% off at 10+ seats. This applies to
 * the per-seat team SKUs (team_perpetual and team_subscription); it does not
 * apply to individual SKUs or to the renewal / sync_addon SKUs (which are
 * already per-seat-year and follow their own pricing).
 */
export const TEAM_VOLUME_THRESHOLD = 10
export const TEAM_VOLUME_DISCOUNT_PCT = 10

/**
 * The per-seat billing models that qualify for the volume discount.
 */
const TEAM_VOLUME_SKUS: ReadonlySet<LocalSkuId> = new Set(["team_perpetual", "team_subscription"])

/**
 * Check whether a SKU qualifies for the team volume discount.
 */
export function qualifiesForTeamVolumeDiscount(sku: LocalSkuId): boolean {
  return TEAM_VOLUME_SKUS.has(sku)
}

/**
 * Per-seat price for a team SKU after any volume discount.
 *
 * Returns the SKU's list `priceUsd` for seat counts below the threshold, and
 * the discounted per-seat price (10% off) for seat counts at or above the
 * threshold. Individual / renewal / sync-addon SKUs never discount — they
 * return their list price regardless of seat count.
 */
export function teamSeatPrice(sku: LocalSkuId, seatCount: number): number {
  const def = LOCAL_SKU_MAP[sku]
  if (!def) {
    throw new Error(`Unknown Local SKU: ${sku}`)
  }
  if (!qualifiesForTeamVolumeDiscount(sku) || seatCount < TEAM_VOLUME_THRESHOLD) {
    return def.priceUsd
  }
  // 10% off the per-seat list price, rounded to 2 decimals (major currency units).
  return Math.round(((def.priceUsd * (100 - TEAM_VOLUME_DISCOUNT_PCT)) / 100) * 100) / 100
}

/**
 * Total price for a team SKU order of `seatCount` seats, applying the volume
 * discount when eligible. For one_time / non-seat SKUs the total is just the
 * list price (seatCount is ignored).
 */
export function teamOrderTotal(sku: LocalSkuId, seatCount: number): number {
  const def = LOCAL_SKU_MAP[sku]
  if (!def) {
    throw new Error(`Unknown Local SKU: ${sku}`)
  }
  if (def.billing === "one_time") {
    return def.priceUsd
  }
  return Math.round(teamSeatPrice(sku, seatCount) * seatCount * 100) / 100
}

/**
 * The discount percentage applied to a given SKU/seatCount (0 when no discount).
 */
export function teamVolumeDiscountPct(sku: LocalSkuId, seatCount: number): number {
  if (!qualifiesForTeamVolumeDiscount(sku) || seatCount < TEAM_VOLUME_THRESHOLD) {
    return 0
  }
  return TEAM_VOLUME_DISCOUNT_PCT
}
