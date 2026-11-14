import { buildScanExecutionPlan, ScanExecutionPlanSchema } from "@lyrashield/types"

export function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "object" && value !== null && "toString" in value) {
    const rendered = String(value)
    if (rendered && rendered !== "[object Object]") return rendered
  }
  return null
}

export function planFacts(value: unknown): {
  applicability: "engine" | "deterministic" | "unavailable"
  maximumUsd: string | null
} {
  const parsed = ScanExecutionPlanSchema.safeParse(value)
  if (!parsed.success || parsed.data.capabilities.length === 0) {
    return { applicability: "unavailable", maximumUsd: null }
  }
  const plan = parsed.data
  if (!plan.capabilities.includes("engine")) {
    try {
      const expected = buildScanExecutionPlan({
        targetType: plan.targetType,
        mode: plan.depth,
        workflow: plan.workflow,
        deterministicOnly: true,
        ...(plan.source ? { source: plan.source } : {}),
        ...(plan.authorizationRef ? { authorizationRef: plan.authorizationRef } : {}),
      })
      const actualCapabilities = new Set(plan.capabilities)
      if (
        expected.capabilities.includes("engine") ||
        expected.profileId !== plan.profileId ||
        expected.scope !== plan.scope ||
        actualCapabilities.size !== plan.capabilities.length ||
        expected.capabilities.length !== plan.capabilities.length ||
        expected.capabilities.some((capability) => !actualCapabilities.has(capability))
      ) {
        return { applicability: "unavailable", maximumUsd: null }
      }
    } catch {
      return { applicability: "unavailable", maximumUsd: null }
    }
  }
  const maximum = plan.limits.maxBudgetUsd
  return {
    applicability: plan.capabilities.includes("engine") ? "engine" : "deterministic",
    maximumUsd:
      typeof maximum === "number" && Number.isFinite(maximum) && maximum >= 0
        ? String(maximum)
        : null,
  }
}
