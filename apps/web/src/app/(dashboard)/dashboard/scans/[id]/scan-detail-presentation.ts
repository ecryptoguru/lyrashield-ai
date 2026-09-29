export { SEVERITY_ICON, SEVERITY_COLOR, SEVERITY_ORDER } from "@/lib/severity-presentation"

export const INTERNAL_ACCOUNTING_EVENT_STAGES = new Set([
  "budget_cap",
  "llm_usage",
  "budget_exceeded",
  "billing_settlement_intent",
])

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
