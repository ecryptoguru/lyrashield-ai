import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Blog-side guard for the 2026-10-04 evidence-state ruling.
 *
 * No code path writes FindingVerificationStatus.VERIFIED. Ingest writes
 * DETECTED or INCONCLUSIVE (apps/worker/src/engine/finding-persister.ts:243)
 * and a deterministic retest writes VALIDATED or INCONCLUSIVE
 * (apps/worker/src/engine/result-integrity/retest-completion.ts:173-179).
 * There is no verification receipt. The shipped states are Detected,
 * Retest-confirmed and Inconclusive.
 *
 * The compare pages and the /methodology page are covered elsewhere
 * (compare-own-claims.test.ts, evidence-states.test.ts). This file covers the
 * blog corpus and the two authoring docs that feed it, which had drifted.
 */
const BLOG_DIR = join(import.meta.dirname, "../content/blog")
const MARKETING_ROOT = join(import.meta.dirname, "../..")

const AUTHORING_DOCS = [
  join(MARKETING_ROOT, "README.md"),
  join(MARKETING_ROOT, "BLOG_AUTHORING.md"),
]

/**
 * A bare negation ("detection alone is not independent verification") is a
 * true statement about the product and stays allowed. Everything else is a
 * claim that the state ships.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["independently verified", /\bindependently\s+verified\b/i],
  ["verification receipt", /\bverification\s+receipts?\b/i],
  ["separate receipt", /\bseparate\s+receipts?\b/i],
  [
    "independent verification",
    /(?<!\bnot\s)(?<!\bnever\s)(?<!\bno\s)(?<!\bwithout\s)\bindependent\s+verification\b/i,
  ],
]

/**
 * The evidence record is a checksum-bound snapshot, not an immutable one.
 * Detection-language uses of "immutable" (immutable commit, immutable build,
 * immutable identifier) are ordinary engineering vocabulary and stay allowed.
 */
const FORBIDDEN_CLAIM_NOUNS =
  /\bimmutable\s+(?:assurance|proof|report|reports|evidence|record|records|snapshot|snapshots|ScoreSnapshot)\b/i

function blogPosts(): string[] {
  return readdirSync(BLOG_DIR)
    .filter((name) => name.endsWith(".mdx"))
    .sort()
}

function violations(file: string, relative: string): string[] {
  const found: string[] = []
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${relative}:${index + 1} [${label}] ${line.trim()}`)
      }
      if (FORBIDDEN_CLAIM_NOUNS.test(line)) {
        found.push(`${relative}:${index + 1} [immutable record claim] ${line.trim()}`)
      }
    })
  return found
}

describe("blog evidence-state copy", () => {
  it("has a blog corpus to scan", () => {
    expect(blogPosts().length).toBeGreaterThan(100)
  })

  it("never presents independent verification as a shipped state", () => {
    const found = blogPosts().flatMap((name) => violations(join(BLOG_DIR, name), `blog/${name}`))
    expect(found, "blog copy claims a shipped independent-verification state").toEqual([])
  })

  it.each(AUTHORING_DOCS.map((file) => [file.slice(MARKETING_ROOT.length + 1), file]))(
    "%s keeps the shipped-state vocabulary",
    (relative, file) => {
      expect(violations(file, relative)).toEqual([])
    }
  )
})
