import { getPlan } from "@lyrashield/pricing"

const price = (planId: "STARTER" | "PRO" | "LAUNCH_ASSURANCE" | "ENTERPRISE") => {
  const plan = getPlan(planId)
  if (!plan) throw new Error(`Missing ${planId} plan in pricing catalog`)
  return `$${plan.price.usd.monthly.toLocaleString("en-US")}`
}

const trial = getPlan("TRIAL")
if (!trial) throw new Error("Missing TRIAL plan in pricing catalog")

export const COMPARISON_PRICING_LADDER = `Trial: ${trial.agentMinutes} one-time agent-minutes; Starter ${price("STARTER")}/month; Pro ${price("PRO")}/month; Launch Assurance ${price("LAUNCH_ASSURANCE")}/month; Enterprise from ${price("ENTERPRISE")}/month`
