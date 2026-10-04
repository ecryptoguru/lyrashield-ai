import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The path is a module-relative constant, not caller input, so the
// non-literal-fs-filename rule does not apply — same suppression the repo's
// other source-reading tests use.
const header = readFileSync(new URL("../components/Header.astro", import.meta.url), "utf8")

/** Strip comments so the explanatory prose about the breakpoint is not matched. */
const code = header.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * The marketing header shows its full nav from lg (1024px) up and collapses to
 * a hamburger below. The row is the logo, five nav items, the theme toggle,
 * Sign in and one accent-filled CTA. It fits at 1024px only because the scoped
 * rule tightens the link padding and gaps inside the lg-to-xl band; without it
 * the row overflowed and the CTA was clipped to "Get starte".
 *
 * These tests pin the breakpoint, the tightening rule and the new five-item
 * contract from the redesign spec section 7.
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
    // Without this the row overflows any viewport under the lg band width.
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

/**
 * The five-item header (redesign spec section 7): Product menu, Coding agents,
 * Free tools menu, Pricing, Learn menu, then Sign in and Start free trial.
 */
describe("marketing header information architecture", () => {
  const navList = code.slice(code.indexOf('<ul class="hidden shrink-0'), code.indexOf("</ul>"))

  it("shows exactly five nav items before the account item", () => {
    // Five nav items plus the single Sign in / Start free trial item.
    // Linear pattern on purpose: eslint security/detect-unsafe-regex rejects
    // the optional-attribute-group form for nested-quantifier backtracking.
    const topLevel = [...navList.matchAll(/<li[\s>]/g)]
    expect(topLevel, "expected five nav items and one account item").toHaveLength(6)
  })

  it("names the five top-level items in order", () => {
    const order = [
      "<span>Product</span>",
      "Coding agents",
      "<span>Free tools</span>",
      "Pricing",
      "<span>Learn</span>",
    ]
    let cursor = -1
    for (const label of order) {
      const at = navList.indexOf(label)
      expect(at, `missing top-level item: ${label}`).toBeGreaterThan(-1)
      expect(at, `item out of order: ${label}`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it("removes WebMCP from the header (D6)", () => {
    expect(navList).not.toMatch(/>\s*WebMCP\s*</)
    expect(navList).not.toContain('href="/webmcp"')
  })

  it("removes Book a demo from the header", () => {
    expect(navList).not.toContain("/demo")
    expect(navList).not.toContain("Book a demo")
  })

  it("keeps the sign-up CTA as the only accent-filled header control", () => {
    const filled = [...navList.matchAll(/<a[\s\S]*?>/g)].filter((match) =>
      match[0].includes("bg-accent")
    )
    expect(filled, "only Start free trial may be accent-filled").toHaveLength(1)
    expect(filled[0]?.[0]).toContain("header_get_started")
  })

  it("marks the current page with an active state", () => {
    expect(code).toContain("const isActive = (href: string)")
    expect(code).toContain("activeClass")
    expect(code).toContain('isActive("/pricing")')
    expect(code).toContain('isActive("/agents")')
  })

  it("keeps the sign-in and sign-up CTA hooks the analytics rely on", () => {
    expect(navList).toContain('data-cta-id="header_sign_in"')
    expect(navList).toContain('data-cta-id="header_get_started"')
    expect(navList).toContain('data-cta-id="header-for-agents"')
  })
})

/**
 * The mobile sheet (item 2.2) carries the same destinations as the desktop
 * header as one accordion per menu and scrolls inside the viewport.
 */
describe("marketing mobile nav sheet", () => {
  const dialog = code.slice(code.indexOf('id="mobile-menu"'), code.indexOf("</dialog>"))

  it("scrolls inside the viewport with max-height 100dvh", () => {
    const rule = code.match(/#mobile-menu\s*\{([\s\S]*?)\n  \}/)?.[1] ?? ""
    expect(rule, "mobile menu sizing rule not found").toContain("max-height: 100dvh")
    expect(rule, "mobile menu must scroll").toContain("overflow-y: auto")
  })

  it("renders one accordion per menu", () => {
    const accordions = [...dialog.matchAll(/<details class="mobile-menu__accordion">/g)]
    expect(accordions).toHaveLength(3)
    for (const label of ["Product", "Free tools", "Learn"]) {
      expect(dialog).toContain(`<summary class="menu-link">${label}</summary>`)
    }
  })

  it("reaches every destination the desktop header offers", () => {
    // The sheet renders the same three menu arrays as the desktop header, plus
    // Pricing and Coding agents as direct links. The arrays are the shared
    // source, so assert each destination is declared in the header at all, then
    // that the sheet renders all three of them.
    for (const href of [
      "/pricing",
      "/agents",
      "/scan",
      "/tools",
      "/methodology",
      "/vibe-security-50",
      "/evidence-vault",
      "/compare",
      "/blog",
      "/docs/integrations",
      "/docs/integrations/rest-api",
      "/support",
      "/#how-it-works",
    ]) {
      // Destinations live either in a menu array (`href: "..."`) or on a direct
      // anchor (`href="..."`).
      const declared = code.includes(`href: "${href}"`) || code.includes(`href="${href}"`)
      expect(declared, `header declares no destination ${href}`).toBe(true)
    }
    // The three accordions render every entry of their array.
    expect(dialog).toContain("{productItems.map")
    expect(dialog).toContain("{freeToolItems.map")
    expect(dialog).toContain("{learnItems.map")
    // Pricing and Coding agents are direct sheet links.
    expect(dialog).toContain('href="/pricing"')
    expect(dialog).toContain('href="/agents"')
  })

  it("keeps the account hooks on the mobile sheet", () => {
    expect(dialog).toContain('data-cta-id="header_sign_in_mobile"')
    expect(dialog).toContain('data-cta-id="header_get_started_mobile"')
    expect(dialog).toContain('data-cta-id="header-for-agents-mobile"')
  })
})
