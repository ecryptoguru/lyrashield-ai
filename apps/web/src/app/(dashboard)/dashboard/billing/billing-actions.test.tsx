import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { BillingActions } from "./billing-actions"

const props = {
  plan: "FREE",
  workspaceId: "ws",
  isLaunchAssurance: false,
  isComplimentary: false,
  purchasesAvailable: true,
  trialAvailable: true,
}
describe("BillingActions", () => {
  it.each(["STARTER", "PRO", "LAUNCH_ASSURANCE"])(
    "keeps paid %s on subscription management",
    (plan) => {
      const html = renderToString(<BillingActions {...props} plan={plan} selectedPlan="PRO" />)
      expect(html).toContain("Manage Subscription")
      expect(html).toContain("review your existing subscription")
      expect(html).not.toContain("Choose a plan")
      expect(html).not.toContain("Choose a billing interval below")
      expect(html).not.toContain("Start free trial")
      expect(html).not.toContain("<button")
    }
  )
  it("does not direct a selected-plan user to a hidden chooser while purchases are off", () => {
    const html = renderToString(
      <BillingActions {...props} selectedPlan="STARTER" purchasesAvailable={false} />
    )
    expect(html).toContain("when new purchases become available")
    expect(html).not.toContain("Choose a billing interval below")
  })
  it("offers a trial while paid purchase admission is off", () => {
    const html = renderToString(<BillingActions {...props} purchasesAvailable={false} />)
    expect(html).toContain("Start free trial")
    expect(html).toContain("60 one-time agent-minutes for 7 days")
    expect(html).toContain("Deep and Custom scans are not included")
    expect(html).not.toContain("Choose a plan")
  })
  it("offers every paid plan and interval with accessible labels", () => {
    const html = renderToString(<BillingActions {...props} />)
    for (const label of ["Starter", "Pro", "Agency"]) {
      for (const interval of ["monthly", "annual"])
        expect(html).toContain(`Choose ${label}, ${interval} billing`)
    }
  })
  it("labels prices in the server-resolved catalog currency without touching checkout", () => {
    // The chooser displays the catalog for the region the server resolved —
    // USD remains the default and INR comes from the trusted request header,
    // never from a client-selected currency.
    const usd = renderToString(<BillingActions {...props} />)
    expect(usd).toContain("Monthly · $29.00/mo")
    expect(usd).toContain("Annual · $295.00/yr")
    expect(usd).toContain("Prices in USD")

    const inr = renderToString(<BillingActions {...props} billingRegion="inr" />)
    expect(inr).toContain("Monthly · ₹2,900.00/mo")
    expect(inr).toContain("Annual · ₹29,500.00/yr")
    expect(inr).toContain("Monthly · ₹9,900.00/mo")
    expect(inr).toContain("Prices in INR")
    expect(inr).not.toContain("$")
  })
  it("retains paid management without advertising a trial", () => {
    const html = renderToString(
      <BillingActions {...props} plan="STARTER" purchasesAvailable={false} />
    )
    expect(html).toContain("Manage Subscription")
    expect(html).not.toContain("Start free trial")
  })
  it("does not offer a provider portal for complimentary access", () => {
    const html = renderToString(
      <BillingActions {...props} plan="LAUNCH_ASSURANCE" isComplimentary />
    )
    expect(html).not.toContain("Manage Subscription")
  })
  it("keeps a validated selection informational and hides used trials", () => {
    const html = renderToString(
      <BillingActions {...props} trialAvailable={false} selectedPlan="PRO" />
    )
    expect(html).toContain("No purchase has been started")
    expect(html).not.toContain("Start free trial")
  })
})
