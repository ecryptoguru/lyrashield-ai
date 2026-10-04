import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const marketingRoot = fileURLToPath(new URL("../", import.meta.url))
const pagesDir = join(marketingRoot, "pages")

/**
 * Spec item 2.3 and ruling D10: no hidden surfaces. Every top-level page under
 * src/pages must be linked from the header or the footer, so a page can never
 * ship reachable only by typing its URL. The footer's own comment states this
 * was always the intent; this test is what enforces it.
 *
 * Only top-level routes are enumerated. Collection routes (/blog/<slug>,
 * /compare/<slug>, /tools/<slug>, /docs/integrations/<slug>) are reached from
 * their own index pages and templates, which are themselves in this list.
 */

/**
 * Deliberately unlinked, each with its reason. Keep this list tiny: adding a
 * page here is the one way to ship a hidden surface, so the reason must be a
 * standing decision, not a convenience.
 */
const UNLINKED_BY_DECISION: Record<string, string> = {
  // D7: /research stays on hold until a real data sample exists, so it is
  // removed from the footer and the header links it nowhere. The page still
  // builds and stays indexable; it is simply not advertised.
  "/research": "on hold until a data sample exists (D7)",
}

function topLevelRoutes(): string[] {
  return (
    readdirSync(pagesDir)
      .filter((name) => name.endsWith(".astro"))
      .map((name) => `/${name.replace(/\.astro$/, "")}`)
      // index.astro is the homepage at "/", and 404 is not a navigable route.
      .filter((route) => route !== "/index" && route !== "/404")
      .sort()
  )
}

function source(path: string): string {
  return readFileSync(join(marketingRoot, path), "utf8")
}

/**
 * Every on-site destination the header or footer renders, ignoring query and
 * fragment. Two shapes carry them: `href="..."` on an anchor, and
 * `href: "..."` inside the footer's `columns` link objects.
 */
function navigableHrefs(): Set<string> {
  const surfaces = [source("components/Header.astro"), source("components/Footer.astro")].join("\n")
  const hrefs = new Set<string>()
  const add = (raw: string) => {
    // Template literals for the account CTAs interpolate appUrl; those are
    // off-site, so they can never satisfy an on-site route.
    if (raw.includes("${")) return
    const path = raw.split("#")[0]?.split("?")[0] ?? ""
    if (path.startsWith("/")) hrefs.add(path.replace(/\/$/, "") || "/")
  }
  for (const match of surfaces.matchAll(/href=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    add(match[1] ?? match[2] ?? "")
  }
  for (const match of surfaces.matchAll(/href:\s*"([^"]+)"/g)) {
    add(match[1] ?? "")
  }
  // The footer's Lite Check entry is the `freeScanHref` variable: an in-page
  // anchor on the homepage, the /scan route everywhere else. Count the route.
  if (surfaces.includes("freeScanHref")) hrefs.add("/scan")
  return hrefs
}

describe("marketing route coverage", () => {
  it("links every top-level page from the header or the footer", () => {
    const linked = navigableHrefs()
    const missing = topLevelRoutes().filter(
      (route) => !linked.has(route) && !(route in UNLINKED_BY_DECISION)
    )
    expect(missing, "pages reachable only by typing the URL").toEqual([])
  })

  it("keeps the unlinked-by-decision list honest", () => {
    // An entry that is in fact linked, or whose page no longer exists, is
    // stale and must be removed rather than left to hide a future page.
    const linked = navigableHrefs()
    for (const route of Object.keys(UNLINKED_BY_DECISION)) {
      expect(
        existsSync(join(pagesDir, `${route.slice(1)}.astro`)),
        `${route} no longer exists`
      ).toBe(true)
      expect(linked.has(route), `${route} is linked; remove it from the exception list`).toBe(false)
    }
  })

  it("finds the expected set of top-level pages", () => {
    // Guards against the enumeration silently matching nothing (a moved
    // directory would otherwise make the coverage assertion vacuously pass).
    const routes = topLevelRoutes()
    expect(routes.length).toBeGreaterThan(15)
    expect(routes).toContain("/pricing")
    expect(routes).toContain("/methodology")
  })

  it("keeps the footer a five-column site map", () => {
    const footer = source("components/Footer.astro")
    for (const column of ["Product", "Trust", "Developers", "Company", "Legal"]) {
      expect(footer, `missing footer column: ${column}`).toContain(`title: "${column}"`)
    }
  })

  it("does not link the on-hold /research page from the footer", () => {
    // D7: /research stays on hold until a sample exists, so it is removed from
    // the footer. The page itself still builds.
    expect(existsSync(join(pagesDir, "research.astro"))).toBe(true)
    expect(source("components/Footer.astro")).not.toContain('href: "/research"')
  })
})
