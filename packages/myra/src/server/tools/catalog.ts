/**
 * read_product_catalog — current commercial facts from the canonical pricing
 * package (never from model memory or stale prose).
 */
import {
  CLOUD_PLANS,
  LOCAL_SKUS,
  MINUTE_PACKS,
  STANDARD_OVERAGE_PER_MINUTE_USD,
  DEEP_SCAN_MULTIPLIER,
} from "@lyrashield/pricing"
import type { MyraComponent } from "../../contracts"
import type { MyraToolContext, MyraToolResult } from "./types"

export async function runReadProductCatalog(
  _ctx: MyraToolContext,
  _input: unknown
): Promise<MyraToolResult> {
  const checkedAt = new Date().toISOString()

  const component: MyraComponent = {
    type: "plan_comparison",
    checkedAt,
    plans: CLOUD_PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyUsd: p.selfServe || p.id === "TRIAL" ? p.price.usd.monthly : p.price.usd.monthly || null,
      monthlyInr: p.price.inr.monthly || null,
      agentMinutes: p.agentMinutes || null,
      targetCaps: p.targetCaps || null,
      memberSeats: p.memberSeats || null,
      deepAllowed: p.deepAllowed,
      selfServe: p.selfServe,
      availability: "available" as const,
      ctaRoute: p.selfServe ? "/pricing" : "/demo",
    })),
    note: "Prices exclude tax. Enterprise is custom — book a demo for contract terms.",
  }

  return {
    data: {
      checkedAt,
      plans: CLOUD_PLANS.map((p) => ({
        id: p.id,
        name: p.name,
        monthlyUsd: p.price.usd.monthly,
        annualUsd: p.price.usd.annual,
        monthlyInr: p.price.inr.monthly,
        agentMinutes: p.agentMinutes,
        targetCaps: p.targetCaps,
        memberSeats: p.memberSeats,
        deepAllowed: p.deepAllowed,
        selfServe: p.selfServe,
      })),
      minutePacks: MINUTE_PACKS.map((p) => ({
        id: p.id,
        minutes: p.minutes,
        priceUsd: p.priceUsd,
        validityDays: p.validityDays,
      })),
      localSkus: LOCAL_SKUS.map((s) => ({
        id: s.id,
        name: s.name,
        priceUsd: s.priceUsd,
        priceInr: s.priceInr ?? null,
        billing: s.billing,
      })),
      notes: {
        tax: "Prices exclude taxes; tax is calculated at checkout where applicable.",
        overagePerMinuteUsd: STANDARD_OVERAGE_PER_MINUTE_USD,
        deepMultiplier: DEEP_SCAN_MULTIPLIER,
        trial: "Trial: 60 one-time agent-minutes, up to 3 targets, 7 days.",
      },
    },
    components: [component],
  }
}
