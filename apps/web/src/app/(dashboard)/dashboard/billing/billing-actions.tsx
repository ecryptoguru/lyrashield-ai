"use client"

import { useRef, useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { formatUSD, getPlan } from "@lyrashield/pricing"
import { useRouter } from "next/navigation"
import { openRazorpaySubscriptionCheckout } from "@/lib/razorpay-checkout"
import { apiPost, ApiError } from "@/lib/api-client"
import { parsePlanIntent } from "@/lib/plan-intent"
import { track } from "@/lib/analytics"

interface BillingActionsProps {
  plan: string
  isLaunchAssurance: boolean
  isComplimentary: boolean
  workspaceId: string
  purchasesAvailable: boolean
  trialAvailable: boolean
  selectedPlan?: string | null
}

const PLANS = [
  ["STARTER", "Starter"],
  ["PRO", "Pro"],
  ["LAUNCH_ASSURANCE", "Agency"],
] as const

export function BillingActions({
  plan,
  isComplimentary,
  workspaceId,
  purchasesAvailable,
  trialAvailable,
  selectedPlan,
}: BillingActionsProps) {
  const router = useRouter()
  const pending = useRef(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const intent = parsePlanIntent(selectedPlan)
  const canStartSubscription = plan === "FREE" && purchasesAvailable

  async function act(action: string, work: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setLoading(action)
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status < 500
          ? cause.message
          : "Could not complete this request. Please try again."
      )
    } finally {
      pending.current = false
      setLoading(null)
    }
  }

  function handleCheckout(targetPlan: string, interval: string) {
    if (!canStartSubscription) return
    track("upgrade_clicked", { plan: targetPlan, interval })
    return act(`checkout-${targetPlan}-${interval}`, async () => {
      track("checkout_started", { plan: targetPlan, interval })
      const data = await apiPost<{ url?: string; subscriptionId?: string; keyId?: string }>(
        "/billing/checkout",
        { workspaceId, plan: targetPlan, interval }
      )
      if (data.url) {
        window.location.assign(data.url)
      } else if (data.subscriptionId && data.keyId) {
        await openRazorpaySubscriptionCheckout({
          keyId: data.keyId,
          subscriptionId: data.subscriptionId,
          onAuthorized: () => router.push("/dashboard/billing?checkout=processing"),
          onDismiss: () => {},
        })
      } else {
        throw new Error("Invalid checkout response")
      }
    })
  }

  return (
    <div className="w-full space-y-4">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {plan === "FREE" && trialAvailable && (
        <section aria-labelledby="start-trial-title" className="rounded-lg border p-4 space-y-2">
          <h3 id="start-trial-title" className="font-semibold">
            Start your free trial
          </h3>
          <p className="text-sm text-muted-foreground">
            60 one-time agent-minutes for 7 days. Deep and Custom scans are not included. No
            purchase required.
          </p>
          <button
            type="button"
            disabled={loading !== null}
            onClick={() =>
              act("trial", async () => {
                await apiPost("/api/billing/trial/start", { workspaceId })
                track("trial_started", { surface: "billing" })
                router.refresh()
              })
            }
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {loading === "trial" ? "Starting trial…" : "Start free trial"}
          </button>
        </section>
      )}
      {intent && (
        <p role="status" className="text-sm">
          Selected plan: {PLANS.find(([id]) => id === intent)?.[1]}.{" "}
          {plan !== "FREE"
            ? isComplimentary
              ? "Your complimentary access is already active."
              : "Use Manage Subscription to review your existing subscription."
            : purchasesAvailable
              ? "Choose a billing interval below when ready."
              : "You can choose a billing interval when new purchases become available."}{" "}
          No purchase has been started.
        </p>
      )}
      {canStartSubscription && (
        <div className="grid gap-3 sm:grid-cols-3" aria-label="Choose a plan">
          {PLANS.map(([targetPlan, label]) => {
            const definition = getPlan(targetPlan)
            const usd = definition?.price.usd
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
                      {definition.agentMinutes} agent-minutes / month · {targets}
                    </p>
                  )}
                </div>
                {(["monthly", "annual"] as const).map((interval) => {
                  const action = `checkout-${targetPlan}-${interval}`
                  const price = usd ? (interval === "annual" ? usd.annual : usd.monthly) : undefined
                  const amount =
                    price === undefined ? null : `${formatUSD(price)}/${interval === "annual" ? "yr" : "mo"}`
                  return (
                    <button
                      key={interval}
                      type="button"
                      onClick={() => handleCheckout(targetPlan, interval)}
                      disabled={loading !== null}
                      aria-label={`Choose ${label}, ${interval} billing${
                        amount ? `, ${amount}` : ""
                      }`}
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
            Prices in USD. Checkout bills in your local currency where the provider offers it.
          </p>
        </div>
      )}
      {plan !== "FREE" && !isComplimentary && (
        <a
          href={`/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Manage Subscription
        </a>
      )}
    </div>
  )
}
