import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const dashboardLayout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const scorecardPage = readFileSync(
  new URL("../(public)/score/[slug]/page.tsx", import.meta.url),
  "utf8"
)

describe("narrow viewport layout", () => {
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
