"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { Badge } from "@lyrashield/ui"
import type { ManualScanOption } from "@/lib/scan-presets"
import { getScanModeLabel, getWorkspacePlanLabel } from "@/lib/enum-labels"
import { pathLabel, type OnboardingPath } from "./onboarding-flow.utils"
import type { OnboardingEligibilityState } from "./onboarding-step-views"

/**
 * The two blocks between the name field and the action footer of the details
 * step: the recommended-review picker and the account-usage panel.
 *
 * They were inline JSX inside TargetDetailsView and are now plain renderer
 * functions that return that same JSX. A function returning elements inlines
 * them at the same point in the tree, so the rendered output is identical to
 * before the move — no component boundary is introduced and the onboarding
 * tests, which walk the returned element tree, see exactly what they saw.
 */

export function reviewPickerSection({
  path,
  reviewOptions,
  selectedReview,
  loading,
  onSelectGoal,
}: {
  path: OnboardingPath
  reviewOptions: ManualScanOption[]
  selectedReview: ManualScanOption | undefined
  loading: boolean
  onSelectGoal: (goal: string) => void
}): ReactNode {
  return (
    /* W2-04: one recommended eligible review, with alternatives behind
        an explicit "Change review" toggle. Essential scope, limitation,
        and usage information stays outside the collapsed details. */
    <fieldset>
      <legend className="mb-2 text-sm font-medium">
        Recommended review for this {pathLabel(path)}
      </legend>
      {selectedReview && (
        <div className="border-primary bg-primary/8 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{selectedReview.label}</span>
            <Badge variant="info">{getScanModeLabel(selectedReview.mode)}</Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{selectedReview.description}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Scope: {selectedReview.scopeSummary} {selectedReview.limitsSummary}. A clean result is
            not a security guarantee.
          </p>
          {selectedReview.authorizationHint && (
            <p className="text-muted-foreground mt-1 text-xs">
              Setup required: {selectedReview.authorizationHint}
            </p>
          )}
          <p className="text-muted-foreground mt-2 text-xs font-medium">Applicable checks</p>
          <ul className="text-muted-foreground mt-1 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {selectedReview.applicableChecks.map((check) => (
              <li key={check} className="flex items-start gap-2">
                <span aria-hidden="true">•</span>
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="mt-2">
        <summary className="text-muted-foreground flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Change review
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {reviewOptions.map((option) => (
            <button
              type="button"
              key={option.id}
              onClick={() => onSelectGoal(option.goal)}
              disabled={loading}
              aria-pressed={selectedReview?.id === option.id}
              className={`min-h-11 rounded-lg border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                selectedReview?.id === option.id ? "border-primary bg-primary/8" : "hover:bg-accent"
              }`}
            >
              <span className="block font-medium">{option.label}</span>
              <span className="text-muted-foreground text-xs">{option.description}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {option.limitsSummary} · {getScanModeLabel(option.mode)}
              </span>
            </button>
          ))}
        </div>
      </details>
      {path === "api" && (
        <p className="text-muted-foreground mt-2 text-xs">
          Add an OpenAPI document after setup to unlock Contract and Contract Behavior reviews.
        </p>
      )}
    </fieldset>
  )
}

export function eligibilitySection({
  targetId,
  eligibility,
}: {
  targetId: string | null
  eligibility: OnboardingEligibilityState
}): ReactNode {
  return (
    <section aria-labelledby="onboarding-eligibility-heading" aria-live="polite">
      <h3 id="onboarding-eligibility-heading" className="text-sm font-semibold">
        Account usage and eligibility
      </h3>
      {!targetId && eligibility.status === "idle" && (
        <p className="text-muted-foreground mt-1 text-sm">
          One click checks your account allowance and starts the scan when the server allows it. The
          server makes the final admission decision when the scan is submitted.
        </p>
      )}
      {eligibility.status === "checking" && (
        <p className="text-muted-foreground mt-1 text-sm" role="status">
          Checking current account usage and scan requirements…
        </p>
      )}
      {eligibility.status === "error" && (
        <div className="border-warning/50 bg-warning/10 mt-2 rounded-lg border p-3 text-sm">
          <p role="status">
            Eligibility could not be checked because the service is temporarily unavailable. No scan
            was started.
          </p>
          <p className="text-muted-foreground mt-1">
            You can retry this check or continue. The scan service checks eligibility again before
            any scan starts.
          </p>
        </div>
      )}
      {eligibility.status === "ready" && eligibility.eligibility.allowed && (
        <p className="mt-2 rounded-lg border p-3 text-sm" role="status">
          Current plan:{" "}
          <span className="font-medium">{getWorkspacePlanLabel(eligibility.eligibility.plan)}</span>{" "}
          · Agent-minutes available:{" "}
          <span className="font-medium">{eligibility.eligibility.remainingMinutes}</span>
          {eligibility.eligibility.isTrial ? " (trial)" : ""}. This advisory can change; the server
          checks eligibility again when you start.
        </p>
      )}
      {eligibility.status === "ready" && !eligibility.eligibility.allowed && (
        <div
          className="border-destructive/40 bg-destructive/5 mt-2 rounded-lg border p-3 text-sm"
          role="alert"
        >
          <p className="font-medium">This review cannot start yet</p>
          <p className="text-muted-foreground mt-1">
            {eligibility.eligibility.message ?? "Required setup or account eligibility is missing."}
          </p>
          {eligibility.eligibility.code === "DOMAIN_VERIFICATION_REQUIRED" && targetId && (
            <Link
              href={`/dashboard/targets/${encodeURIComponent(targetId)}#domain-verification`}
              className="text-primary mt-2 inline-flex min-h-11 items-center font-medium underline underline-offset-4"
            >
              Verify this domain
            </Link>
          )}
          {["NO_MINUTES_REMAINING", "TRIAL_EXPIRED", "DEEP_NOT_ALLOWED"].includes(
            eligibility.eligibility.code ?? ""
          ) && (
            <Link
              href="/dashboard/billing"
              className="text-primary mt-2 inline-flex min-h-11 items-center font-medium underline underline-offset-4"
            >
              Review account usage
            </Link>
          )}
          {[
            "TARGET_AUTHORIZATION_FAILED",
            "VERIFICATION_REQUIRED",
            "GITHUB_INSTALLATION_REQUIRED",
            "NO_REPOSITORIES",
            "CONNECTION_EXPIRED",
          ].includes(eligibility.eligibility.code ?? "") && (
            <Link
              href="/dashboard/connections"
              className="text-primary mt-2 inline-flex min-h-11 items-center font-medium underline underline-offset-4"
            >
              Review connected access
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
