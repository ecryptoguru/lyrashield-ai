import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { BillingReturnNotice } from "./billing-return-notice"

describe("BillingReturnNotice", () => {
  it("renders a truthful, accessible Razorpay processing state with a manual refresh", () => {
    const html = renderToString(<BillingReturnNotice checkout="processing" provider="razorpay" />)

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain("Payment submitted; provider confirmation is processing.")
    expect(html).toContain("Razorpay in INR")
    expect(html).toContain("Refresh billing status")
  })

  it("does not invent a completed payment state", () => {
    expect(renderToString(<BillingReturnNotice checkout="cancelled" provider="polar" />)).toBe("")
  })
})
