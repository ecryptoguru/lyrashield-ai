import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const component = readFileSync(
  new URL("../components/StickyMobileCta.astro", import.meta.url),
  "utf8"
)
const base = readFileSync(new URL("../layouts/Base.astro", import.meta.url), "utf8")

/**
 * Sticky mobile CTA bar (item 2.4). The Playwright spec covers the reveal
 * threshold and the desktop absence; these assertions cover the parts a
 * disabled-field preview build cannot exercise (hide-on-focus) and the
 * eligibility contract, which is a source-level fact.
 */
describe("sticky mobile CTA bar", () => {
  it("is mounted once in the base layout, after the footer", () => {
    expect(base).toContain('import StickyMobileCta from "@components/StickyMobileCta.astro"')
    expect(base).toContain("<StickyMobileCta />")
    expect(base.indexOf("<Footer />")).toBeLessThan(base.indexOf("<StickyMobileCta />"))
  })

  it("renders only on Home, Pricing and Scan", () => {
    expect(component).toContain('const eligible = ["/", "/pricing", "/scan"].includes(path)')
  })

  it("is mobile-only and never renders without an app URL", () => {
    expect(component).toContain("lg:hidden")
    expect(component).toContain("eligible && appUrl")
  })

  it("hides while a form control is focused so it cannot cover a field", () => {
    // The reveal condition requires both past-first-screen AND no focused field.
    expect(component).toContain('["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)')
    expect(component).toContain("const next = pastFirstScreen && !fieldFocused")
    expect(component).toContain('bar.classList.toggle("hidden", !shown)')
    // Focus handling is bound and unbound so the bar returns after blur.
    expect(component).toContain('document.addEventListener(\n          "focusin"')
    expect(component).toContain('document.addEventListener(\n          "focusout"')
  })

  it("reveals after one screen of scroll", () => {
    expect(component).toContain("window.scrollY > window.innerHeight")
  })

  it("carries the one sign-up label and its own CTA hook", () => {
    expect(component).toContain("{CTA_LABEL.signUp}")
    expect(component).toContain('data-cta-id="sticky_get_started"')
  })

  it("respects the device safe area so it never sits under a home indicator", () => {
    expect(component).toContain("env(safe-area-inset-bottom)")
  })
})
