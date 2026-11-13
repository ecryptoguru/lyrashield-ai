import {
  CLOUD_PLANS,
  DEEP_SCAN_MULTIPLIER,
  MINUTE_PACKS,
  PACK_VALIDITY_DAYS,
  STANDARD_OVERAGE_PER_MINUTE_USD,
  formatUSD,
} from "@lyrashield/pricing"

function formatCatalogUsd(amount: number): string {
  return formatUSD(amount).replace(/\.00$/, "")
}

export function buildLlmsPricingSummary(): string {
  const trial = CLOUD_PLANS.find((plan) => plan.id === "TRIAL")
  if (!trial) throw new Error("The pricing catalog is missing the Trial plan")

  const paidPlanPrices = CLOUD_PLANS.filter((plan) => plan.id !== "TRIAL").map((plan) => {
    if (!plan.selfServe) {
      return `${plan.name} starts at ${formatCatalogUsd(plan.price.usd.monthly)}/month (contact-led)`
    }

    const annualPrice =
      plan.price.usd.annual > 0 ? ` and ${formatCatalogUsd(plan.price.usd.annual)}/year` : ""
    return `${plan.name} ${formatCatalogUsd(plan.price.usd.monthly)}/month${annualPrice}`
  })
  const packPrices = MINUTE_PACKS.map(
    (pack) => `${pack.minutes} minutes ${formatCatalogUsd(pack.priceUsd)}`
  ).join("; ")

  return `Pricing: Trial includes ${trial.agentMinutes} one-time agent-minutes. ${paidPlanPrices.join("; ")}. Minute packs: ${packPrices}. Packs are valid for ${PACK_VALIDITY_DAYS} days. Agency overage is ${formatCatalogUsd(STANDARD_OVERAGE_PER_MINUTE_USD)} per agent-minute, subject to a user-set spend limit. Deep/Custom scans use a ${DEEP_SCAN_MULTIPLIER}× minute multiplier. Regional INR prices and plan limits are published on /pricing.`
}
