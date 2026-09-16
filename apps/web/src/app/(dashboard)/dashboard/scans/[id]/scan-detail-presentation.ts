import { Shield, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react"

export const INTERNAL_ACCOUNTING_EVENT_STAGES = new Set([
  "budget_cap",
  "llm_usage",
  "budget_exceeded",
])

export const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

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

export const EVENT_LEVEL_COLOR: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

export const SCANNER_LABELS: Record<string, string> = {
  engine: "Engine review",
  agent_config: "Agent configuration",
  sca: "Dependency scan",
  secrets: "Secret scan",
  url: "URL scan",
  ai_app_security: "AI app security",
  ml_supply_chain: "ML supply chain",
  sast: "Static analysis",
  iac: "Infrastructure config scan",
  external_import: "Imported scan (third-party)",
}
