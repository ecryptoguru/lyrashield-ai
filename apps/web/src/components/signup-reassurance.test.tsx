import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import { SignupReassurance } from "./signup-reassurance"

describe("signup reassurance", () => {
  it("derives trial capacity from the catalog and keeps review depth explicit", () => {
    const html = renderToStaticMarkup(<SignupReassurance plan={null} />)
    expect(html).toContain(`${CLOUD_PLAN_MAP.TRIAL.trialDays}-day free trial`)
    expect(html).toContain(`${CLOUD_PLAN_MAP.TRIAL.agentMinutes} agent-minutes`)
    expect(html).toContain(`${CLOUD_PLAN_MAP.TRIAL.targetCaps} targets`)
    expect(html).toContain("no card")
    expect(html).toContain("Safe, Quick and Standard")
    expect(html).toContain("Deep and Custom require Pro or above")
  })

  it.each(["STARTER", "PRO", "LAUNCH_ASSURANCE"] as const)(
    "keeps %s selection distinct from payment authorization",
    (plan) => {
      const html = renderToStaticMarkup(<SignupReassurance plan={plan} />)
      expect(html).toContain(CLOUD_PLAN_MAP[plan].name)
      expect(html).toContain("review billing and confirm your plan")
      expect(html).toContain("No payment is taken here")
      expect(html).not.toContain("free trial")
    }
  )
})
