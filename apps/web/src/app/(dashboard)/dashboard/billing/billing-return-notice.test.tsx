import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { BillingReturnNotice } from "./billing-return-notice"

describe("BillingReturnNotice", () => {
  it("keeps a forged success query pending until server account state updates", () => {
    const html = renderToString(
      <BillingReturnNotice
        checkout="success"
        provider="razorpay"
        plan="FREE"
        planName="Free"
        trialActive
        accountHasPaidPlan={false}
      />
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain("Provider confirmation is still processing.")
    expect(html).toContain("A return URL does not grant plan access.")
    expect(html).toContain("Razorpay in INR")
    expect(html).toContain("Refresh billing status")
    expect(html).not.toContain("Payment submitted")
    expect(html).not.toContain("checkout_completed")
  })

  it("shows current server entitlement without claiming settlement", () => {
    const html = renderToString(
      <BillingReturnNotice
        checkout="processing"
        provider="polar"
        plan="PRO"
        planName="Pro"
        trialActive={false}
        accountHasPaidPlan
      />
    )
    expect(html).toContain("Your account currently shows")
    expect(html).toContain("Pro")
    expect(html).toContain("access.")
    expect(html).toContain("does not confirm settlement of a specific payment")
    expect(html).not.toContain("still processing")
  })

  it("keeps canceled returns neutral and does not offer a checkout retry", () => {
    const html = renderToString(
      <BillingReturnNotice
        checkout="cancelled"
        provider="polar"
        plan="FREE"
        planName="Free"
        trialActive={false}
        accountHasPaidPlan={false}
      />
    )
    expect(html).toContain("The provider returned a canceled checkout status.")
    expect(html).toContain("Your current account state remains authoritative.")
    expect(html).not.toContain("Refresh billing status")
  })
})
