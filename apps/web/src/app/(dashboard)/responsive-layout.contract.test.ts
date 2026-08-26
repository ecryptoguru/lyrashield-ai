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
    expect(dashboardLayout).toContain("pb-[calc(4rem+env(safe-area-inset-bottom))] md:pt-0 md:pb-0")
  })

  it("allows public scorecard status panels to shrink before the small breakpoint", () => {
    expect(scorecardPage).toContain('className="min-w-0 space-y-4 sm:min-w-64"')
    expect(scorecardPage).toContain("min-h-12 flex-wrap items-center justify-between")
  })
})
