import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const dashboardLayout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8")
const scorecardPage = readFileSync(
  new URL("../(public)/score/[slug]/page.tsx", import.meta.url),
  "utf8"
)

describe("narrow viewport layout", () => {
  it("places the keyboard bypass before both sidebar and mobile navigation", () => {
    const skipLink = dashboardLayout.indexOf('href="#main-content"')
    expect(skipLink).toBeGreaterThan(-1)
    expect(skipLink).toBeLessThan(dashboardLayout.indexOf("<V2Sidebar"))
    expect(skipLink).toBeLessThan(dashboardLayout.indexOf("<MobilePageHeader"))
    expect(dashboardLayout).toContain('id="main-content"')
    expect(dashboardLayout).toContain("tabIndex={-1}")
  })

  it("keeps dashboard content above the fixed mobile navigation", () => {
    // UF-27: the fixed mobile chrome (bottom bar + page header) is the shell
    // below `lg`, because the sidebar no longer appears at tablet widths.
    expect(dashboardLayout).toContain("pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pt-0 lg:pb-0")
    expect(dashboardLayout).toContain("flex-col lg:flex-row")
  })

  it("allows public scorecard status panels to shrink before the small breakpoint", () => {
    expect(scorecardPage).toContain('className="min-w-0 space-y-4 sm:min-w-64"')
    expect(scorecardPage).toContain("min-h-12 flex-wrap items-center justify-between")
  })
})
