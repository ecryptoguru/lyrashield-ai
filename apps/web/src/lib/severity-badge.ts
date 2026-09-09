/**
 * Shared severity → badge-variant map. The dashboard colors a severity the
 * same way everywhere (findings list, fixes list, any future consumer); this
 * module is the single copy so the mapping cannot drift.
 *
 * Unknown severities fall back to "muted" at the call site — the map holds
 * only the canonical five values.
 */
export type SeverityBadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

export const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "muted",
}
