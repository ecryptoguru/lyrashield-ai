// Public scan-mode presets mapped to estimated wall-clock minutes for the UI.
// These are conservative UX estimates, not runtime guarantees.

const MINUTES_BY_MODE: Record<string, { low: number; high: number }> = {
  SAFE: { low: 5, high: 8 },
  QUICK: { low: 5, high: 8 },
  STANDARD: { low: 8, high: 15 },
  DEEP: { low: 25, high: 40 },
  CUSTOM: { low: 20, high: 60 },
}

export function estimateRunMinutes(mode: string, assetCount = 1): { low: number; high: number } {
  const fallback: { low: number; high: number } = { low: 8, high: 20 }
  const base = MINUTES_BY_MODE[mode.toUpperCase()] ?? fallback
  const multiplier = Math.max(1, assetCount)
  return {
    low: base.low * multiplier,
    high: base.high * multiplier,
  }
}

export function formatEstimate({ low, high }: { low: number; high: number }): string {
  if (low === high) return `${low} min`
  return `${low}–${high} min`
}
