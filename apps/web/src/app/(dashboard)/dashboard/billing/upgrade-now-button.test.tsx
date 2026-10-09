import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({ rememberPlanIntent: vi.fn() }))
vi.mock("@/lib/plan-intent", () => ({ rememberPlanIntent: hoisted.rememberPlanIntent }))

import { UpgradeNowButton } from "./upgrade-now-button"
import { PLAN_PICKER_ID } from "./plan-picker"

describe("UpgradeNowButton", () => {
  it("points at the plan picker on this page instead of linking back to it", () => {
    const html = renderToStaticMarkup(<UpgradeNowButton />)

    // W1/P2-4: this was a Link to /dashboard/billing?plan=PRO rendered inside
    // /dashboard/billing, so the only visible effect was a reload.
    expect(html).not.toContain("href=")
    expect(html).not.toContain("/dashboard/billing?plan=PRO")
    expect(html).toContain("<button")
    expect(html).toContain(`aria-controls="${PLAN_PICKER_ID}"`)
    expect(html).toContain("Upgrade Now")
  })

  it("records no plan preference merely by rendering", () => {
    renderToStaticMarkup(<UpgradeNowButton />)
    expect(hoisted.rememberPlanIntent).not.toHaveBeenCalled()
  })
})
