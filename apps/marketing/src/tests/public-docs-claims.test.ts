import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const ROOT = join(import.meta.dirname, "../../../..")
const REQUIRED = ["README.md", "docs/user-guide.md", "docs/litepaper.md"]
const WARN_ONLY = ["docs/whitepaper.md", "docs/yellowpaper.md"]
const UPSTREAM = ["str", "ix"].join("")

// Check each sentence so a future-state disclaimer cannot excuse a live claim
// elsewhere on the same line. Tables and list items are sentences too.
function violations(text: string): string[] {
  const found: string[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const plain = line.replace(/[*`_]/g, "")
    if (/\bimmutable\b/i.test(plain)) found.push(`${index + 1}: immutable`)
    if (plain.toLowerCase().includes(UPSTREAM)) found.push(`${index + 1}: upstream name`)
    for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
      const negated = /\b(?:does not|do not|never)\s+produce\s+independently\s+verified\b/i
      if (/\bindependently\s+verified\b/i.test(sentence.replace(negated, ""))) {
        found.push(`${index + 1}: independent verification claim`)
      }
      const statement = sentence.replace(negated, "")
      const findingState =
        /\bVERIFIED\b/.test(statement) ||
        /^\s*\|?\s*verified\s*\|/i.test(statement) ||
        (/\bverified\b/i.test(statement) &&
          /\b(?:findings?|states?|status|results?)\b/i.test(statement))
      const futureOnly =
        /\b(?:future|reserved|defined)\b/i.test(sentence) &&
        /\b(?:not produced today|no finding is in it today|no current scan produces|current scans do not produce)\b/i.test(
          sentence
        )
      if (findingState && !futureOnly) found.push(`${index + 1}: live finding state`)
    }
  })
  return found
}

function checkDocument(path: string, text: string, warnOnly: boolean): string[] {
  const found = violations(text).map((match) => `${path}:${match}`)
  if (warnOnly && found.length) console.warn(found.join("\n"))
  return warnOnly ? [] : found
}

describe("public document claim matcher", () => {
  const disallowed = [
    "A finding has VERIFIED status.",
    "Findings are verified.",
    "VERIFIED means a completed trusted check.",
    "| verified | Produced on every scan |",
    "Reports retain immutable snapshots.",
    "We produce independently verified findings.",
    `Powered by ${["STR", "IX"].join("")}.`,
    "VERIFIED is a future-only status and is not produced today. Findings are verified.",
    "VERIFIED is a future status that findings can use today.",
  ]

  it.each(disallowed.map((text, index) => [index + 1, text] as const))(
    "rejects disallowed fixture %i",
    (_index, text) => {
      expect(violations(text).length).toBeGreaterThan(0)
    }
  )

  it.each([
    "VERIFIED is a future-only status and is not produced today.",
    "VERIFIED is defined for a future step; no finding is in it today.",
    "| VERIFIED | Future independent verification step; not produced today |",
    "The product does not produce independently verified findings.",
    "Target ownership uses a verified domain.",
    "API-key callers act under checked credential permissions.",
  ])("allows a bounded statement: %s", (text) => {
    expect(violations(text)).toEqual([])
  })

  it("warns without failing for the two reference papers", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(checkDocument("paper.md", "An immutable verdict.", true)).toEqual([])
      expect(warning).toHaveBeenCalledWith("paper.md:1: immutable")
    } finally {
      warning.mockRestore()
    }
  })
})

describe("public document claims", () => {
  it.each(REQUIRED)("keeps %s within the public wording contract", (path) => {
    expect(checkDocument(path, readFileSync(join(ROOT, path), "utf8"), false)).toEqual([])
  })

  it.each(WARN_ONLY)("reports %s in warning mode only", (path) => {
    expect(checkDocument(path, readFileSync(join(ROOT, path), "utf8"), true)).toEqual([])
  })

  it("states the approval and credential permission contract", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8")
    expect(readme).toContain(
      "Fix pull requests open only from a server-generated patch and only after approval."
    )
    expect(readme).toContain("A browser session records a human approval.")
    expect(readme).toContain(
      "API-key and delegated OAuth callers act under the `fix:approve` permission instead of a per-request approval."
    )
    expect(readme).toContain("Requesting a Fix PR also requires `fix:create_pr`.")
    expect(readme).toContain("Nothing auto-merges.")
  })
})
