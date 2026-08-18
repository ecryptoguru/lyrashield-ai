/**
 * Prepaid agent-minute pack definitions.
 *
 * Packs are additive to any cloud plan. They expire after 6 months and
 * have a per-minute overage rate. Deep/Custom scans consume minutes at
 * 3× the standard rate.
 */

export type PackId = "pack_100" | "pack_250" | "pack_500"

export interface MinutePack {
  id: PackId
  name: string
  /** Number of agent-minutes included. */
  minutes: number
  /** Price in USD (major units). */
  priceUsd: number
  /** Validity period in days from purchase. */
  validityDays: number
  /** Overage rate per minute in USD (major units). */
  overagePerMinuteUsd: number
  /** Multiplier applied to minutes consumed by Deep/Custom scans. */
  deepMultiplier: number
}

export const MINUTE_PACKS: readonly MinutePack[] = [
  {
    id: "pack_100",
    name: "100-Minute Pack",
    minutes: 100,
    priceUsd: 15,
    validityDays: 180,
    overagePerMinuteUsd: 0.15,
    deepMultiplier: 3,
  },
  {
    id: "pack_250",
    name: "250-Minute Pack",
    minutes: 250,
    priceUsd: 30,
    validityDays: 180,
    overagePerMinuteUsd: 0.15,
    deepMultiplier: 3,
  },
  {
    id: "pack_500",
    name: "500-Minute Pack",
    minutes: 500,
    priceUsd: 50,
    validityDays: 180,
    overagePerMinuteUsd: 0.15,
    deepMultiplier: 3,
  },
] as const

/** Map of pack id → MinutePack for O(1) lookup. */
export const MINUTE_PACK_MAP: Readonly<Record<PackId, MinutePack>> = Object.fromEntries(
  MINUTE_PACKS.map((p) => [p.id, p])
) as Readonly<Record<PackId, MinutePack>>

/** Standard overage rate when all packs are exhausted. */
export const STANDARD_OVERAGE_PER_MINUTE_USD = 0.15

/** Deep/Custom scan minute multiplier. */
export const DEEP_SCAN_MULTIPLIER = 3

/** Pack validity in days (all packs share the same validity). */
export const PACK_VALIDITY_DAYS = 180
