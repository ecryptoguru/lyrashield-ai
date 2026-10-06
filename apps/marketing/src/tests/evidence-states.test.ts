import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

/**
 * Copy rule from the founder's ruling addendum (2026-10-04): no code sets a
 * finding to VERIFIED, so no public page may say LyraShield independently
 * verifies findings or issues verification receipts for them. The three
 * shipped evidence states are Detected, Retest-confirmed and Inconclusive.
 *
 * The fourth state stays in the schema and the dashboard, so the methodology
 * page may explain it — but only as a future step, never as a promise.
 * That one explanation is allowlisted below by exact file and line content.
 */
const ALLOWLIST: Array<{ file: string; text: string }> = [
  {
    file: "pages/methodology.astro",
    text: 'name: "Independently verified (future step)"',
  },
  {
    file: "pages/methodology.astro",
    text: "A fourth state, independently verified, is defined for a future separate verification step; no finding is in it today.",
  },
  {
    file: "pages/methodology.astro",
    text: "establish the condition is gone. A fourth state, independently verified, is defined for a",
  },
  {
    file: "pages/methodology.astro",
    text: "A fourth state, independently verified, is defined for a future separate verification step; no finding is in it today. A score or clean result never overrides these facts.",
  },
  {
    // A no-finding result genuinely is not independent verification. The
    // negation is the point of the sentence, so it stays.
    file: "pages/vibe-security-50.astro",
    text: "is not independent verification and LyraShield never shows it as passed.",
  },
]

/** Files that render customer-facing marketing copy. */
function copyFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      copyFiles(full, found)
      continue
    }
    if (name.endsWith(".test.ts")) continue
    if (name.endsWith(".astro") || name.endsWith(".ts")) found.push(full)
  }
  return found
}

const FORBIDDEN =
  /\bindependently verified\b|\bverification receipt\b|\bindependent verification\b/i

describe("public evidence-state copy", () => {
  it.each(["litepaper.md", "whitepaper.md", "yellowpaper.md"])(
    "marks the independent-verification state as future-only in %s",
    (name) => {
      const document = readFileSync(join(src, "../../../docs", name), "utf8")
      const state = document.split(/\r?\n/).find((line) => /\| `VERIFIED`|→ VERIFIED/.test(line))
      expect(state, `${name} must qualify its independent-verification state`).toMatch(
        /future|not produced/i
      )
      expect(document).toMatch(/three shipped evidence states/i)
    }
  )

  it("never presents independent verification as a shipped state", () => {
    const violations: string[] = []
    for (const file of copyFiles(src)) {
      const relative = file.slice(src.length + 1)
      // The 13 compare pages live under src/content and are owned by the
      // compare consolidation; everything else, including /research, is swept.
      if (relative.startsWith("content/")) continue
      const allowed = ALLOWLIST.filter((entry) => entry.file === relative).map((e) => e.text)
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line) => {
          if (!FORBIDDEN.test(line)) return
          if (allowed.some((text) => line.includes(text))) return
          violations.push(`${relative}: ${line.trim()}`)
        })
    }
    expect(violations, "public copy claims a shipped independent-verification state").toEqual([])
  })

  it("keeps every allowlist entry real, so the exception cannot drift", () => {
    for (const entry of ALLOWLIST) {
      const body = readFileSync(join(src, entry.file), "utf8")
      expect(body, `${entry.file} no longer contains its allowlisted line`).toContain(entry.text)
    }
  })

  it("describes the three shipped states in the journey block", () => {
    const world = readFileSync(join(src, "components/landing/EvidenceWorld.astro"), "utf8")
    // Anchor on the state chip and take the enclosing list, so the assertion
    // survives whitespace and indentation changes.
    const anchor = world.indexOf('class="state-detected"')
    expect(anchor, "journey state list not found").toBeGreaterThan(-1)
    const start = world.lastIndexOf("<ul", anchor)
    const list = world.slice(start, world.indexOf("</ul>", anchor))
    for (const label of ["Detected", "Retest-confirmed", "Inconclusive"]) {
      expect(list, `journey state list is missing ${label}`).toContain(`/>${label}</li>`)
    }
    expect(list).not.toContain("state-verified")
    // The three-state list must not repeat a state chip.
    expect(list.match(/class="state-/g)).toHaveLength(3)
  })

  it("never calls a report immutable and describes what it actually is", () => {
    // Scope: a *report* must not be called immutable. The Evidence Vault does
    // keep append-only, immutable *versions* of the attestations you submit,
    // which is a different claim and is allowed to say so.
    const violations: string[] = []
    for (const file of copyFiles(src)) {
      const relative = file.slice(src.length + 1)
      if (relative.startsWith("content/")) continue
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line) => {
          if (/\bimmutable\b/i.test(line) && /report/i.test(line)) {
            violations.push(`${relative}: ${line.trim()}`)
          }
        })
    }
    expect(violations, "a report is described as immutable").toEqual([])

    // The replacement claim must be the checksum-bound one the report service
    // actually implements.
    const manifest = readFileSync(
      join(src, "../../../packages/db/src/manifest-checksum.ts"),
      "utf8"
    )
    expect(manifest).toContain('createHash("sha256")')
    expect(manifest).toContain("MATCH")
  })

  it("states the Fix PR rule in the approved wording", () => {
    const surfaces = ["pages/about.astro", "pages/methodology.astro", "pages/index.astro"].map(
      (path) => readFileSync(join(src, path), "utf8")
    )
    for (const surface of surfaces) {
      expect(surface).toContain("Fix PR")
      // "Fix PRs open only after..." and "A Fix PR opens only after..." are both
      // the approved wording.
      expect(surface).toMatch(/Fix PRs? opens? only after a human approves/)
      expect(surface).not.toMatch(/automatic Fix PR|Fix PRs? (?:are|is) automatic/i)
    }
  })
})
