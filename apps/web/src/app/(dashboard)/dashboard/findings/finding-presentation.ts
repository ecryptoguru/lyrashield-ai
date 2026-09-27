export { SEVERITY_ICON, SEVERITY_COLOR, SEVERITY_ORDER } from "@/lib/severity-presentation"

export type BadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

export const STATUS_BADGE: Record<string, BadgeVariant> = {
  OPEN: "danger",
  FIX_READY: "info",
  PR_OPENED: "info",
  FIXED: "success",
  FIXED_PENDING_RETEST: "success",
  ACCEPTED_RISK: "muted",
  FALSE_POSITIVE: "muted",
  DUPLICATE: "muted",
}

export function extractEpssPercentage(technicalDetail?: string | null): string | undefined {
  const marker = "FIRST EPSS: "
  const valueStart = technicalDetail?.indexOf(marker) ?? -1
  if (!technicalDetail || valueStart < 0) return undefined

  const start = valueStart + marker.length
  const end = technicalDetail.indexOf("%", start)
  if (end < start || end - start > 6) return undefined

  const percentage = technicalDetail.slice(start, end)
  return Number.isFinite(Number(percentage)) ? `${percentage}%` : undefined
}
