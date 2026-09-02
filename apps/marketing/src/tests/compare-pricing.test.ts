import { describe, expect, it } from "vitest"

import { getPlan } from "@lyrashield/pricing"
import { COMPARISON_PRICING_LADDER } from "../lib/compare-pricing"

describe("comparison pricing ladder", () => {
  it("derives every displayed amount from the pricing catalog", () => {
    const trial = getPlan("TRIAL")
    const starter = getPlan("STARTER")
    const pro = getPlan("PRO")
    const launch = getPlan("LAUNCH_ASSURANCE")
    const enterprise = getPlan("ENTERPRISE")
    expect(COMPARISON_PRICING_LADDER).toBe(
      `Trial: ${trial?.agentMinutes} one-time agent-minutes; Starter $${starter?.price.usd.monthly}/month; Pro $${pro?.price.usd.monthly}/month; Launch Assurance $${launch?.price.usd.monthly}/month; Enterprise from $${enterprise?.price.usd.monthly.toLocaleString("en-US")}/month`
    )
  })
})
