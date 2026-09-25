import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The path is a module-relative constant, not caller input, so the
// non-literal-fs-filename rule does not apply — same suppression the repo's
// other source-reading tests use.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const header = readFileSync(new URL("../components/Header.astro", import.meta.url), "utf8")

/** Strip comments so the explanatory prose about the breakpoint is not matched. */
const code = header.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * The marketing header shows its full nav from lg (1024px) up and collapses to a
 * hamburger below. The row is naturally ~1097px wide, so it overflowed the page
 * by up to 73px between 1024px and ~1096px (iPad landscape, small laptops) —
 * "Get started" was clipped to "Get starte".
 *
 * The fix keeps the lg breakpoint and tightens the link padding and gaps inside
 * the lg-to-xl band so the row fits. These tests pin both halves: the breakpoint
 * stays at lg, AND the tightening rule exists. Removing the tightening while
 * leaving the breakpoint at lg re-opens the overflow band.
 */
describe("marketing header nav fit", () => {
  it("keeps the full nav switching on at lg, not higher", () => {
    const ul = code.match(/<ul class="hidden shrink-0[^"]*"/)?.[0] ?? ""
    expect(ul, "primary nav list not found").not.toBe("")
    expect(ul, "primary nav must switch on at lg").toContain("lg:flex")
  })

  it("keeps the hamburger available below lg", () => {
    const toggle = code.match(/id="menu-toggle"[\s\S]{0,400}?class="([^"]*)"/)?.[1] ?? ""
    expect(toggle, "menu toggle not found").not.toBe("")
    expect(toggle, "hamburger must be hidden at lg, i.e. lg:hidden").toContain("lg:hidden")
  })

  it("tightens the nav padding and gaps inside the lg-to-xl band", () => {
    // Without this the ~1097px row overflows any viewport under ~1104px.
    const band = code.match(
      /@media \(min-width: 1024px\) and \(max-width: 1279px\)\s*\{([\s\S]*?)\n  \}/
    )?.[1]
    expect(band, "the lg-to-xl fit rule is missing from Header.astro").toBeTruthy()
    expect(band, "nav padding must be tightened").toMatch(/padding-(left|right): 0\.5rem/)
    expect(band, "nav gaps must be tightened").toMatch(/gap: 0\.25rem/)
  })

  it("does not hide the full nav above lg, which would strand widths that fit", () => {
    // Regression guard for an earlier over-correction that moved the breakpoint
    // to xl and hid the nav at 1159px, where it fits fine.
    const ul = code.match(/<ul class="hidden shrink-0[^"]*"/)?.[0] ?? ""
    expect(ul).not.toContain("xl:flex")
  })
})
