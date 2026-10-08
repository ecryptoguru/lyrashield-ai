import { useEffect } from "react"
import { ACQUISITION_COOKIE } from "@/lib/analytics"
import { rememberPlanIntent } from "@/lib/plan-intent"

/**
 * One-time entry effects for the wizard: remember the plan intent the user
 * arrived with, and drop the acquisition cookie. The acquisition snapshot is
 * already in durable account state server-side, so the cookie has done its job.
 *
 * Self-contained and behaviour-preserving: both dependencies are declared, and
 * the body touches nothing beyond module constants, so it stays exhaustive-deps
 * clean. It lives here rather than inline so the wizard component carries only
 * the wiring its steps need.
 */
export function useOnboardingEntryEffects({
  selectedPlan,
  acquisitionCookiePresent,
}: {
  selectedPlan?: string | null
  acquisitionCookiePresent?: boolean
}) {
  useEffect(() => {
    rememberPlanIntent(selectedPlan)
    if (acquisitionCookiePresent) {
      document.cookie = `${ACQUISITION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    }
  }, [selectedPlan, acquisitionCookiePresent])
}
