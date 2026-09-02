/** Selection only: never used as a redirect target or checkout authorization. */
export const PLAN_INTENT_COOKIE = "lyrashield-plan-intent"

/** Short-lived, non-sensitive preference; validated again on every server read. */
export function rememberPlanIntent(value: unknown): void {
  const plan = parsePlanIntent(value)
  if (plan) {
    document.cookie = `${PLAN_INTENT_COOKIE}=${plan}; Path=/; Max-Age=86400; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`
  }
}

export function parsePlanIntent(value: unknown): "STARTER" | "PRO" | "LAUNCH_ASSURANCE" | null {
  return value === "STARTER" || value === "PRO" || value === "LAUNCH_ASSURANCE" ? value : null
}

export function planIntentPath(path: "/onboarding" | "/dashboard/billing", value: unknown): string {
  const plan = parsePlanIntent(value)
  return plan ? `${path}?plan=${plan}` : path
}
