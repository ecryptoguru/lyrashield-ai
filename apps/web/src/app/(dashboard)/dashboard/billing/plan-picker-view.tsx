"use client"

import type { ReactNode } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { formatINR, formatUSD, getPlan } from "@lyrashield/pricing"
import { PLAN_PICKER_ID } from "./plan-picker"

export const BILLING_PLANS = [
  ["STARTER", "Starter"],
  ["PRO", "Pro"],
  ["LAUNCH_ASSURANCE", "Agency"],
] as const

const REGION_FORMAT = { usd: formatUSD, inr: formatINR } as const

function planChoiceLabel(
  label: string,
  interval: string,
  loading: boolean,
  amount: string | null
): string {
  const cadence = interval === "annual" ? "Annual" : "Monthly"
  return `Choose ${label}, ${interval} billing${amount ? `, ${amount}` : ""} — ${
    loading ? "Starting checkout…" : amount ? `${cadence} · ${amount}` : `${cadence} billing`
  }`
}

/**
 * The plan picker: one card per plan, one button per interval, and the region
 * price note. It was the inline body of BillingActions and is now a plain
 * renderer function that returns that same JSX, so the elements appear at the
 * same point in the tree — no component boundary is introduced and the billing
 * tests, which walk the returned element tree, see exactly what they saw.
 */
export function planPicker({
  billingRegion,
  loading,
  onCheckout,
}: {
  billingRegion: "usd" | "inr"
  loading: string | null
  onCheckout: (targetPlan: string, interval: string) => void
}): ReactNode {
  return (
    <div
      id={PLAN_PICKER_ID}
      className="grid scroll-mt-6 gap-3 sm:grid-cols-3"
      aria-label="Choose a plan"
    >
      {BILLING_PLANS.map(([targetPlan, label]) => {
        const definition = getPlan(targetPlan)
        const catalog = definition?.price[billingRegion]
        const targets =
          definition && definition.targetCaps > 0
            ? `up to ${definition.targetCaps} targets`
            : "custom target limits"
        return (
          <section key={targetPlan} className="min-w-0 space-y-2 rounded-lg border p-3">
            <div className="space-y-1">
              <h3 className="font-medium">{label}</h3>
              {definition && (
                <p className="text-xs text-muted-foreground">
                  {definition.agentMinutes.toLocaleString("en-US")} agent-minutes / month ·{" "}
                  {targets}
                </p>
              )}
            </div>
            {(["monthly", "annual"] as const).map((interval) => {
              const action = `checkout-${targetPlan}-${interval}`
              const price = catalog
                ? interval === "annual"
                  ? catalog.annual
                  : catalog.monthly
                : undefined
              const amount =
                price === undefined
                  ? null
                  : `${REGION_FORMAT[billingRegion](price)}/${interval === "annual" ? "yr" : "mo"}`
              return (
                <button
                  key={interval}
                  type="button"
                  onClick={() => onCheckout(targetPlan, interval)}
                  disabled={loading !== null}
                  aria-label={planChoiceLabel(label, interval, loading === action, amount)}
                  className={`${buttonVariants({ variant: "outline", size: "sm" })} w-full`}
                >
                  {loading === action
                    ? "Starting checkout…"
                    : amount
                      ? `${interval === "annual" ? "Annual" : "Monthly"} · ${amount}`
                      : interval === "annual"
                        ? "Annual billing"
                        : "Monthly billing"}
                </button>
              )
            })}
          </section>
        )
      })}
      <p className="text-xs text-muted-foreground sm:col-span-3">
        {billingRegion === "inr"
          ? "Prices in INR for your region's checkout. Final amounts are confirmed by the provider before payment."
          : "Prices in USD. Checkout bills in your local currency where the provider offers it."}
      </p>
    </div>
  )
}
