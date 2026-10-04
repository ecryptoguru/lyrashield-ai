import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wave 5 acceptance tests: trust pages.
 *
 * Handoff section 1 Wave 5 (items 5.1 to 5.5) and Spec sections 6 and 9.
 * /methodology becomes the single home of the doctrine; the other trust pages
 * link to it instead of restating it. One date format. One mailbox rule.
 */
const src = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
function page(name: string): string {
  return readFileSync(new URL(`../pages/${name}`, import.meta.url), "utf8")
}

/**
 * Trust pages that must carry a "Last reviewed" line. /terms is excluded: its
 * wording is owned by another developer thread (the founder's do-not-touch
 * list), so its date format is theirs to change.
 */
const TRUST_PAGES = [
  "methodology.astro",
  "about.astro",
  "ai-safety.astro",
  "vibe-security-50.astro",
  "evidence-vault.astro",
  "security-reporting.astro",
  "terms-of-sale.astro",
  "privacy.astro",
] as const

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "content") continue
      sourceFiles(full, found)
      continue
    }
    if (name.endsWith(".test.ts")) continue
    if (name.endsWith(".astro") || name.endsWith(".ts")) found.push(full)
  }
  return found
}

describe("Wave 5 trust pages", () => {
  it("5.1 keeps the doctrine on /methodology as one home", () => {
    const methodology = page("methodology.astro")
    expect(methodology).toContain("Evidence states")
    expect(methodology).toContain("Coverage states")
    expect(methodology).toContain("does not claim")
  })

  it("5.2 links to /methodology instead of restating the doctrine", () => {
    for (const name of ["about.astro", "vibe-security-50.astro"] as const) {
      expect(page(name), `${name} must link to /methodology`).toContain('href="/methodology"')
    }
  })

  it("5.3 uses one result-state vocabulary on the Vibe Security 50 page", () => {
    const vibe = page("vibe-security-50.astro")
    expect(vibe).toContain("Control outcomes")
    // "Evidence state" belongs to /methodology, not to the control outcomes.
    expect(vibe).not.toMatch(/evidence state/i)
  })

  it("5.4 shows one date format and a Last reviewed line on every trust page", () => {
    // The vocabulary lock fixes the format as "4 Oct 2026".
    const DATE = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/
    const violations: string[] = []
    for (const name of TRUST_PAGES) {
      const body = page(name)
      if (!body.includes("Last reviewed:")) violations.push(`${name} has no Last reviewed line`)
      const reviewedLine = body.split("\n").find((line) => line.includes("Last reviewed:")) ?? ""
      if (!DATE.test(reviewedLine)) {
        violations.push(`${name} does not use the "4 Oct 2026" date format`)
      }
    }
    expect(violations).toEqual([])
  })

  it("5.5 states the one mailbox rule and never publishes admin@", () => {
    const base = readFileSync(new URL("../layouts/Base.astro", import.meta.url), "utf8")
    // The JSON-LD security contact is the security mailbox, not support@.
    expect(base).toContain(
      '(import.meta.env.PUBLIC_SECURITY_EMAIL as string | undefined) || "security@lyrashieldai.com"'
    )
    const violations: string[] = []
    for (const file of sourceFiles(src)) {
      const relative = file.slice(src.length + 1)
      if (readFileSync(file, "utf8").includes("admin@lyrashieldai.com")) {
        violations.push(relative)
      }
    }
    expect(violations).toEqual([])
  })
})
