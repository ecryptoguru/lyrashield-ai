"use client"

import Link from "next/link"
import { Button } from "@lyrashield/ui"
import { ChevronRight } from "lucide-react"
import type { ManualScanOption } from "@/lib/scan-presets"
import { isBillingRecoveryCode } from "./scans-client.utils"
import type { ScanEligibilityState } from "./scan-types"

export function ScanEligibilityRecovery({
  eligibility,
  enabledOptions,
  choosePreset,
  canManageBilling,
  startingTrial,
  handleStartTrial,
  selectedTarget,
}: {
  eligibility: Extract<ScanEligibilityState, { status: "ready" }>
  enabledOptions: ManualScanOption[]
  choosePreset: (id: string) => void
  canManageBilling: boolean
  startingTrial: boolean
  handleStartTrial: () => Promise<void>
  selectedTarget: string
}) {
  return (
    <div
      className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm"
      role="alert"
    >
      <p className="font-medium">This review cannot start yet</p>
      <p className="text-muted-foreground mt-1">
        {eligibility.eligibility.message ?? "Not allowed for this workspace."}
      </p>
      {eligibility.eligibility.code === "TARGET_RELAY_UNAVAILABLE" &&
        enabledOptions
          .filter((option) => !option.usesAi)
          .map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              className="mt-2 min-h-11"
              onClick={() => choosePreset(option.id)}
            >
              Choose {option.label}
            </Button>
          ))}
      {eligibility.eligibility.code === "TRIAL_AVAILABLE" &&
        (canManageBilling ? (
          <Button
            type="button"
            size="sm"
            className="mt-2"
            disabled={startingTrial}
            onClick={handleStartTrial}
          >
            {startingTrial ? "Starting trial…" : "Start free trial"}
          </Button>
        ) : (
          <p className="text-muted-foreground mt-2">Ask a workspace owner to start the trial.</p>
        ))}
      {isBillingRecoveryCode(eligibility.eligibility.code) && (
        <p className="mt-2">
          {canManageBilling ? (
            <Link
              href="/dashboard/billing"
              className="text-primary inline-flex min-h-11 items-center gap-1 font-medium hover:underline"
            >
              Review billing options
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          ) : (
            <span className="text-muted-foreground">
              Ask a workspace owner to review billing options.
            </span>
          )}
        </p>
      )}
      {eligibility.eligibility.code === "DOMAIN_VERIFICATION_REQUIRED" && selectedTarget && (
        <Link
          href={`/dashboard/targets/${encodeURIComponent(selectedTarget)}#domain-verification`}
          className="text-primary mt-2 inline-flex min-h-11 items-center font-medium hover:underline"
        >
          Verify control of this domain
        </Link>
      )}
    </div>
  )
}
