import { Shield, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react"

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

// Severity icons mirror scan-detail-client.tsx SEVERITY_ICON (WCAG 1.4.1).
export const SEVERITY_ICON: Record<string, typeof Shield> = {
  CRITICAL: ShieldX,
  HIGH: ShieldAlert,
  MEDIUM: Shield,
  LOW: ShieldCheck,
  INFO: ShieldCheck,
}

export const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "text-destructive",
  HIGH: "text-orange-600 dark:text-orange-400",
  MEDIUM: "text-amber-600 dark:text-amber-400",
  LOW: "text-sky-600 dark:text-sky-400",
  INFO: "text-muted-foreground",
}

export const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
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
