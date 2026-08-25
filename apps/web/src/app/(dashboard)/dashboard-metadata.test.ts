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
 * title would be dead metadata. Exemption is detected from the source rather
 * than hardcoded, so adding a new compatibility alias needs no test edit.
 *
 * The fs traversal below walks this test file's own directory inside the repo
 * to enumerate route files — no external or user input reaches these paths,
 * which is why the security/detect-non-literal-fs-filename warnings are
 * suppressed at each call site (same approach as the sibling *.contract.test.ts
 * files in this app, which has no component test harness).
 */

const DASHBOARD_ROOT = join(__dirname, "dashboard")

function collectPageFiles(dir: string): string[] {
  const found: string[] = []
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (statSync(full).isDirectory()) {
      found.push(...collectPageFiles(full))
    } else if (entry === "page.tsx") {
      found.push(full)
    }
  }
  return found
}

function readSource(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(file, "utf8")
}

/** A page that only issues a redirect never renders, so it needs no metadata. */
function isRedirectOnly(source: string): boolean {
  return (
    /\b(permanentRedirect|redirect)\s*\(/.test(source) &&
    !/\breturn\s*\(/.test(source) &&
    !/<[A-Z]/.test(source)
  )
}

const pages = collectPageFiles(DASHBOARD_ROOT).map((file) => ({
  file,
  source: readSource(file),
}))

describe("dashboard route metadata", () => {
  it("finds the dashboard routes to check", () => {
    expect(pages.length).toBeGreaterThan(20)
  })

  it("declares a title on every rendering route", () => {
    const missing = pages
      .filter(({ source }) => !isRedirectOnly(source))
      .filter(({ source }) => !/export const metadata/.test(source))
      .map(({ file }) => file)
    expect(missing).toEqual([])
  })

  it("never re-appends the brand a page already inherits from the layout template", () => {
    // The layout applies "%s | LyraShield AI", so a page title carrying the
    // brand itself would render "Billing | LyraShield AI | LyraShield AI".
    const doubled = pages
      .map(({ file, source }) => {
        const match = source.match(/export const metadata[^{]*\{\s*title:\s*"([^"]+)"/)
        return match?.[1] && /LyraShield AI/.test(match[1]) ? `${file} -> ${match[1]}` : null
      })
      .filter((entry): entry is string => entry !== null)
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
