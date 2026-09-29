export const INTERNAL_ACCOUNTING_EVENT_STAGES = new Set([
  "budget_cap",
  "llm_usage",
  "budget_exceeded",
  "billing_settlement_intent",
])

export function filterDashboardScanEvents<T extends { stage: string }>(events: readonly T[]): T[] {
  return events.filter((event) => !INTERNAL_ACCOUNTING_EVENT_STAGES.has(event.stage))
}
