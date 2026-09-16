type SeverityBadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

export const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "muted",
}
