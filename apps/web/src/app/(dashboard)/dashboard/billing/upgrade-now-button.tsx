"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { TrendingUp } from "lucide-react"
import { rememberPlanIntent } from "@/lib/plan-intent"
import { PLAN_PICKER_ID } from "./plan-picker"

/**
 * Moves the user to the plan picker on the page they are already on.
 *
 * This was a `Link` to `/dashboard/billing?plan=PRO` — the route that renders
 * it, so the only visible effect was a full page reload and a status line. It
 * now records the Pro preference and scrolls to, then focuses, the first
 * checkout control in the picker. No navigation, no reload.
 */
export function UpgradeNowButton() {
  const [missing, setMissing] = useState(false)

  function goToPlanPicker() {
    rememberPlanIntent("PRO")
    const picker = document.getElementById(PLAN_PICKER_ID)
    const firstChoice = picker?.querySelector<HTMLElement>("button")
    if (!picker || !firstChoice) {
      // The picker renders only while purchases are available and the plan is
      // Free. Say so instead of reloading the page for no reason.
      setMissing(true)
      return
    }
    setMissing(false)
    picker.scrollIntoView({ block: "center", behavior: "smooth" })
    firstChoice.focus({ preventScroll: true })
  }

  return (
    <div className="w-full space-y-2">
      <button
        type="button"
        onClick={goToPlanPicker}
        aria-controls={PLAN_PICKER_ID}
        className={`${buttonVariants({ variant: "default" })} w-full`}
      >
        <TrendingUp className="mr-2 h-4 w-4" aria-hidden="true" />
        Upgrade Now
      </button>
      {missing && (
        <p role="status" className="text-muted-foreground text-xs">
          Plan choices are not available on this page right now. Review the plan section above.
        </p>
      )}
    </div>
  )
}
