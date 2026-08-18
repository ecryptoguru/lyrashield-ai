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
  | "sync_addon";

export interface LocalSku {
  id: LocalSkuId;
  name: string;
  description: string;
  /** Price in USD (major units). */
  priceUsd: number;
  /** Billing period: "one_time", "per_seat", "per_seat_year". */
  billing: "one_time" | "per_seat" | "per_seat_year";
  /** Whether this SKU includes update eligibility. */
  includesUpdates: boolean;
  /** Update eligibility duration in days (null = perpetual). */
  updateDays: number | null;
}

export const LOCAL_SKUS: readonly LocalSku[] = [
  {
    id: "individual_launch",
    name: "Individual — Launch",
    description: "Single-user perpetual license at launch pricing.",
    priceUsd: 199,
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
] as const;

/** Map of SKU id → LocalSku for O(1) lookup. */
export const LOCAL_SKU_MAP: Readonly<Record<LocalSkuId, LocalSku>> =
  Object.fromEntries(LOCAL_SKUS.map((s) => [s.id, s])) as Readonly<
    Record<LocalSkuId, LocalSku>
  >;
