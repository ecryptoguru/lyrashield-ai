import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { metadata as dashboardLayoutMetadata } from "./layout"

/**
 * Every rendering dashboard route must declare its own title.
 *
 * Without one, Next.js falls back to the root layout's marketing title, so an
 * authenticated page shows "LyraShield AI — Release assurance for AI-built
 * apps" in the tab and browser history. That is what shipped for most of these
 * routes before this test existed.
 *
 * Routes whose page is a pure redirect are exempt: they never render, so a
 * title would be dead metadata.
 */

const DASHBOARD_ROOT = join(__dirname, "dashboard")

function collectPageFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectPageFiles(full))
    } else if (entry === "page.tsx") {
      found.push(full)
    }
  }
  return found
}

/** A page that only issues a redirect never renders, so it needs no metadata. */
function isRedirectOnly(source: string): boolean {
  return (
    /\b(permanentRedirect|redirect)\s*\(/.test(source) &&
    !/\breturn\s*\(/.test(source) &&
    !/<[A-Z]/.test(source)
  )
}

describe("dashboard route metadata", () => {
  const pages = collectPageFiles(DASHBOARD_ROOT)

  it("finds the dashboard routes to check", () => {
    expect(pages.length).toBeGreaterThan(20)
  })

  it("declares a title on every rendering route", () => {
    const missing: string[] = []
    for (const file of pages) {
      const source = readFileSync(file, "utf8")
      if (isRedirectOnly(source)) continue
      if (!/export const metadata/.test(source)) missing.push(file)
    }
    expect(missing).toEqual([])
  })

  it("never re-appends the brand a page already inherits from the layout template", () => {
    // The layout applies "%s | LyraShield AI", so a page title carrying the
    // brand itself would render "Billing | LyraShield AI | LyraShield AI".
    const doubled: string[] = []
    for (const file of pages) {
      const source = readFileSync(file, "utf8")
      const match = source.match(/export const metadata[^{]*\{\s*title:\s*"([^"]+)"/)
      if (match?.[1] && /LyraShield AI/.test(match[1])) doubled.push(`${file} -> ${match[1]}`)
    }
    expect(doubled).toEqual([])
  })

  it("keeps authenticated dashboard pages out of search indexes", () => {
    expect(dashboardLayoutMetadata.robots).toMatchObject({ index: false, follow: false })
  })

  it("supplies a title template and a default so no route can fall back to the marketing title", () => {
    expect(dashboardLayoutMetadata.title).toMatchObject({
      template: "%s | LyraShield AI",
      default: "Dashboard | LyraShield AI",
    })
  })
})
