import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { BillingActions } from "./billing-actions"

const props = {
  plan: "FREE",
  workspaceId: "ws",
  isLaunchAssurance: false,
  purchasesAvailable: true,
  trialAvailable: true,
}
describe("BillingActions", () => {
  it("offers a trial while paid purchase admission is off", () => {
    const html = renderToString(<BillingActions {...props} purchasesAvailable={false} />)
    expect(html).toContain("Start free trial")
    expect(html).toContain("100 one-time agent-minutes for 14 days")
    expect(html).toContain("Deep and Custom scans are not included")
    expect(html).not.toContain("Choose a plan")
  })
  it("offers every paid plan and interval with accessible labels", () => {
    const html = renderToString(<BillingActions {...props} />)
    for (const label of ["Starter", "Pro", "Launch Assurance"]) {
      for (const interval of ["monthly", "annual"])
        expect(html).toContain(`Choose ${label}, ${interval} billing`)
    }
  })
  it("retains paid management without advertising a trial", () => {
    const html = renderToString(
      <BillingActions {...props} plan="STARTER" purchasesAvailable={false} />
    )
    expect(html).toContain("Manage Subscription")
    expect(html).not.toContain("Start free trial")
  })
  it("keeps a validated selection informational and hides used trials", () => {
    const html = renderToString(
      <BillingActions {...props} trialAvailable={false} selectedPlan="PRO" />
    )
    expect(html).toContain("No purchase has been started")
    expect(html).not.toContain("Start free trial")
  })
})
