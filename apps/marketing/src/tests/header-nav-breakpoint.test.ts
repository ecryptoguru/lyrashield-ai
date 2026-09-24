import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The marketing header collapses to a hamburger below one breakpoint and shows
 * the full nav above it. If that breakpoint is set too low the nav overflows
 * the viewport AND the hamburger disappears at exactly the width where the nav
 * it replaced no longer fits — so the menu becomes unreachable too.
 *
 * That shipped: at lg (1024px) the header row needed ~1064px, so at 1024x768
 * (iPad landscape, small laptops) the page overflowed by 73px horizontally
 * (document scrollWidth 1097 vs clientWidth 1024) and the hamburger was
 * hidden. Fixed by moving the switch to xl (1280px).
 *
 * This guard pins the four sites that must stay in lockstep. A stray `lg:`
 * on any of them re-introduces the bug at 1024-1279px.
 */
const header = readFileSync(new URL("../components/Header.astro", import.meta.url), "utf8")

/** Strip comments so the explanatory prose about `lg:` is not matched. */
const code = header.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

describe("marketing header nav breakpoint", () => {
  it("shows the full nav only at xl, never at lg", () => {
    const ul = code.match(/<ul class="hidden shrink-0[^"]*"/)?.[0] ?? ""
    expect(ul, "primary nav list not found").not.toBe("")
    expect(ul, "primary nav must switch on at xl").toContain("xl:flex")
    expect(ul, "primary nav must not switch on at lg (overflows 1024-1279px)").not.toContain(
      "lg:flex"
    )
  })

  it("hides the hamburger only at xl, so the collapsed menu stays reachable", () => {
    const toggle = code.match(/id="menu-toggle"[\s\S]{0,400}?class="([^"]*)"/)?.[1] ?? ""
    expect(toggle, "menu toggle not found").not.toBe("")
    expect(toggle, "hamburger must stay visible until xl").toContain("xl:hidden")
    expect(toggle, "hamburger must not be hidden at lg — that strands 1024-1279px").not.toContain(
      "lg:hidden"
    )
  })

  it("hides the mobile menu dialog only at xl", () => {
    const dialog = code.match(/id="mobile-menu"[\s\S]{0,400}?class="([^"]*)"/)?.[1] ?? ""
    expect(dialog, "mobile menu dialog not found").not.toBe("")
    expect(dialog, "menu dialog must stay available until xl").toContain("xl:hidden")
    expect(dialog).not.toContain("lg:hidden")
  })

  it("does not hide any header control at lg while showing the full nav", () => {
    // Any lg:hidden in the header would vanish exactly when the nav appears.
    const offenders = code.match(/lg:hidden/g) ?? []
    expect(offenders, "no header control may be lg:hidden while the nav switches at xl").toEqual([])
  })
})
