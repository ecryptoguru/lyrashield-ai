import { useState } from "react"
import { Button } from "@lyrashield/ui"
import { OnboardingAlerts } from "../../apps/web/src/app/onboarding/onboarding-step-views"
import { presentOperationFailure } from "../../apps/web/src/lib/operation-failure"
import { BillingActions } from "../../apps/web/src/app/(dashboard)/dashboard/billing/billing-actions"
import { UpgradeNowButton } from "../../apps/web/src/app/(dashboard)/dashboard/billing/upgrade-now-button"

/**
 * Browser harness for the two focus/navigation fixes:
 *
 * - the onboarding alert that used to appear off-screen above a long step
 * - the billing "Upgrade Now" control that used to reload the page it was on
 *
 * Both are interaction behaviours, so they belong in the browser harness
 * rather than a Node render assertion.
 */
export default function UxFocusHarness() {
  const mode = new URLSearchParams(location.search).get("ux")
  return mode === "billing" ? <BillingHarness /> : <AlertHarness />
}

function AlertHarness() {
  const [failure, setFailure] = useState<{
    presentation: ReturnType<typeof presentOperationFailure>
    retry: (() => void) | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <main>
      <OnboardingAlerts
        failure={failure}
        error={error}
        loading={false}
        onRetryFailure={() => {}}
      />
      {/* The step the alert renders above is tall enough that the button the
          user pressed is off-screen on a phone. */}
      <section
        aria-label="Target details"
        className="rounded-xl border p-5"
        style={{ height: "1800px" }}
      >
        <h1>Target details</h1>
        <p>Review card, checks list, eligibility panel and warning stack here.</p>
        <Button
          type="button"
          onClick={() =>
            setFailure({
              presentation: presentOperationFailure("SCAN_RATE_LIMITED"),
              retry: () => {},
            })
          }
        >
          Start release check
        </Button>
        <Button
          type="button"
          onClick={() => {
            setFailure(null)
            setError("Workspace and repository are required.")
          }}
        >
          Start with a plain error
        </Button>
        <Button
          type="button"
          onClick={() => {
            setError(null)
            // The recovery a lost connection produces: the retry offered is a
            // status read, never a new submission.
            setFailure({
              presentation: presentOperationFailure("NETWORK_ERROR"),
              retry: () => {},
            })
          }}
        >
          Simulate a lost connection
        </Button>
      </section>
    </main>
  )
}

function BillingHarness() {
  return (
    <main>
      <section aria-label="Trial status" className="rounded-xl border p-6" style={{ height: "900px" }}>
        <h1>Trial status</h1>
        <p>Days left, minutes left, targets.</p>
        <UpgradeNowButton />
      </section>
      <section aria-label="Current plan" className="rounded-xl border p-6">
        <h2>Current Plan</h2>
        <BillingActions
          plan="FREE"
          isLaunchAssurance={false}
          isComplimentary={false}
          workspaceId="ws-a"
          purchasesAvailable
          trialAvailable={false}
        />
      </section>
    </main>
  )
}
