import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Mobile-shell regressions that a type checker and a build cannot catch.
 *
 * Both bugs here shipped to production as a blank-looking defect: the sign-in
 * screens lost their only route back to the marketing site, and the dashboard's
 * Myra composer triggered the iOS focus zoom, which magnifies the page and
 * leaves it scrolled sideways. Neither shows up in SSR output — the zoom is a
 * runtime browser behaviour keyed off computed font-size, and the missing link
 * is a `md:` visibility rule. Guard the source shapes directly.
 */
function read(relative: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL(relative, import.meta.url), "utf8")
}

describe("mobile form-control sizing", () => {
  const css = read("./globals.css").replace(/\s+/g, " ")

  it("pins text fields to 16px below 768px so iOS does not zoom on focus", () => {
    // iOS Safari zooms the viewport when a focused text field computes under
    // 16px, and does not zoom back out. The dashboard's Myra composer and
    // inline fields are `text-sm` (14px), so the guard has to cover textarea,
    // select and the non-native input types at the mobile breakpoint.
    const start = css.indexOf("@media (max-width: 767px)")
    expect(start, "globals.css has no 767px breakpoint").toBeGreaterThan(-1)

    const guard = css.slice(start, start + 600)
    expect(guard, "767px block does not set 16px").toContain("font-size: 16px")
    expect(guard, "textarea not covered").toContain("textarea")
    expect(guard, "select not covered").toContain("select")
    expect(guard, "text input not covered").toMatch(/input:not\(\[type="checkbox"\]\)/)
  })
})

describe("auth screens keep a route back to the marketing site", () => {
  const layout = read("../components/auth-split-layout.tsx")

  it("renders a marketing nav that is visible on mobile", () => {
    // The rich product panel (and its lyrashieldai.com / Methodology / Docs
    // links) is desktop-only. Without a mobile counterpart, anyone landing on
    // sign-in or sign-up from a bookmark or link is stranded on the app domain.
    const start = layout.indexOf('aria-label="LyraShield links"')
    expect(start, "auth layout has no LyraShield links nav").toBeGreaterThan(-1)

    const nav = layout.slice(start, start + 2000)
    expect(nav, "nav is not mobile-visible").toContain("md:hidden")
    expect(nav, "nav does not link to the marketing site").toContain("marketingUrl")
    // Touch targets stay comfortable on a phone.
    expect(nav, "nav links are under 44px").toContain("min-h-11")
  })
})
