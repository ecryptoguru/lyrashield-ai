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
    // The vocabulary lock fixes the format as "4 Oct 2026". A page may print
    // the date literally or derive it from its single editorial-date constant
    // (so text, datetime attribute, JSON-LD and sitemap cannot disagree); a
    // derived label must keep the same d-MMM-yyyy shape.
    const DATE = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/
    const DERIVED_LABEL = /\{(?:reviewedLabel|updatedDateLabel|reviewedDateLabel)\}/
    const violations: string[] = []
    for (const name of TRUST_PAGES) {
      const body = page(name)
      if (!body.includes("Last reviewed:")) violations.push(`${name} has no Last reviewed line`)
      const reviewedLine = body.split("\n").find((line) => line.includes("Last reviewed:")) ?? ""
      if (DERIVED_LABEL.test(reviewedLine)) {
        if (!body.includes('toLocaleDateString("en-GB"')) {
          violations.push(`${name} derives its label outside the en-GB d MMM yyyy shape`)
        }
      } else if (!DATE.test(reviewedLine)) {
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

  it("5.6 drives @tailwindcss/typography from the site theme, not the OS", () => {
    // Tailwind emits `dark:` utilities inside @media (prefers-color-scheme: dark),
    // but this site switches theme with :root[data-theme] and lets the visitor
    // override the OS. So `dark:prose-invert` on the trust pages followed the
    // operating system instead of the theme: with a dark OS and the site set to
    // light, `.prose` headings stayed pure #fff on the #f5f9fa page and were
    // invisible. The prose variables are mapped to the site's own tokens in
    // global.css, which overrides Tailwind's layered utilities.
    const styles = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8")
    for (const mapping of [
      "--tw-prose-body: var(--text-muted)",
      "--tw-prose-headings: var(--text)",
      "--tw-prose-lead: var(--text-muted)",
      "--tw-prose-links: var(--accent)",
      "--tw-prose-bold: var(--text)",
      "--tw-prose-quote-borders: var(--accent)",
      "--tw-prose-th-borders: var(--border)",
    ]) {
      expect(styles, `global.css must map ${mapping}`).toContain(mapping)
    }
    // The mapping must not be scoped to one theme: both themes read the tokens.
    const mappingBlock = styles.slice(styles.indexOf(".prose {"))
    expect(mappingBlock.slice(0, mappingBlock.indexOf("}"))).not.toContain("data-theme")
  })

  it("5.7 keeps prose surfaces free of OS-bound and undefined classes", () => {
    // Two leftovers found in a production pass:
    //  - `dark:prose-invert` follows prefers-color-scheme, not :root[data-theme],
    //    so it is the wrong mechanism here and is now inert. Removed from the
    //    markup so the trap is not left implied.
    //  - `prose-themed` was a class name with no rule anywhere: dead weight.
    const offenders: string[] = []
    for (const file of sourceFiles(src)) {
      const relative = file.slice(src.length + 1)
      const body = readFileSync(file, "utf8")
      if (/\bdark:prose-/.test(body)) offenders.push(`${relative} uses a dark: prose variant`)
      if (/\bprose-themed\b/.test(body))
        offenders.push(`${relative} uses the undefined prose-themed`)
    }
    expect(offenders).toEqual([])
  })

  it("5.8 gives every inline prose link visible styling", () => {
    // The reported shape was an inline link in body copy with no colour or
    // underline. A link inside a `prose` container inherits accent + underline
    // from the prose variables; a link outside one must carry its own classes.
    // This walks each trust page and fails if a bare inline link sits outside
    // the page's prose container.
    const bareAnchorOutsideProse = (source: string): string[] => {
      const lines = source.split("\n")
      const found: string[] = []
      let depth = 0
      let proseDepth: number | null = null
      lines.forEach((line, index) => {
        if (proseDepth === null && /class="[^"]*\bprose\b/.test(line)) proseDepth = depth
        const opens = line.match(/<div\b/g)?.length ?? 0
        const closes = line.match(/<\/div>/g)?.length ?? 0
        for (const match of line.matchAll(/<a\b([^>]*)>/g)) {
          if (proseDepth === null && !match[1].includes("class=")) {
            found.push(`line ${index + 1}`)
          }
        }
        depth += opens
        if (proseDepth !== null && closes > 0 && depth - closes <= proseDepth) proseDepth = null
        depth -= closes
      })
      return found
    }

    const offenders: string[] = []
    for (const name of TRUST_PAGES) {
      const body = page(name)
      const bare = bareAnchorOutsideProse(body)
      if (bare.length > 0) offenders.push(`${name}: ${bare.join(", ")}`)
    }
    expect(offenders).toEqual([])
  })
})
