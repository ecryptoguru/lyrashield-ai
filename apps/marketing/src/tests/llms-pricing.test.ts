import { readFileSync } from "node:fs"
import { CLOUD_PLANS, MINUTE_PACKS, formatUSD } from "@lyrashield/pricing"
import { describe, expect, it } from "vitest"
import { buildLlmsPricingSummary } from "../lib/llms-pricing"

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

function catalogUsd(amount: number): string {
  return formatUSD(amount).replace(/\.00$/, "")
}

describe("llms.txt pricing summary", () => {
  it("renders plan and minute-pack amounts from the pricing catalog", () => {
    const summary = buildLlmsPricingSummary()

    for (const plan of CLOUD_PLANS) {
      if (plan.id === "TRIAL") {
        expect(summary).toContain(`${plan.agentMinutes} one-time agent-minutes`)
      } else if (plan.selfServe) {
        expect(summary).toContain(`${catalogUsd(plan.price.usd.monthly)}/month`)
        if (plan.price.usd.annual > 0) {
          expect(summary).toContain(`${catalogUsd(plan.price.usd.annual)}/year`)
        }
      } else {
        expect(summary).toContain(`starts at ${catalogUsd(plan.price.usd.monthly)}/month`)
      }
    }

    for (const pack of MINUTE_PACKS) {
      expect(summary).toContain(`${pack.minutes} minutes ${catalogUsd(pack.priceUsd)}`)
    }
  })

  it("uses the generated catalog summary in the llms.txt route", () => {
    const llmsRoute = source("../pages/llms.txt.ts")

    expect(llmsRoute).toContain("buildLlmsPricingSummary()")
    expect(llmsRoute).not.toMatch(/Starter is \$\d/)
  })
})
