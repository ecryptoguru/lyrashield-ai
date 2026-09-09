import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  HOME_LABEL,
  ISSUE_PLURAL,
  ISSUE_SINGULAR,
  RUN_PLURAL,
  RUN_SINGULAR,
  SCAN_PLURAL,
  SCAN_SINGULAR,
} from "./terminology"

describe("user-facing terminology", () => {
  it("uses the canonical Scan and Finding nouns", () => {
    expect(RUN_SINGULAR).toBe("Scan")
    expect(RUN_PLURAL).toBe("Scans")
    expect(SCAN_SINGULAR).toBe("Scan")
    expect(SCAN_PLURAL).toBe("Scans")
    expect(ISSUE_SINGULAR).toBe("Finding")
    expect(ISSUE_PLURAL).toBe("Findings")
    expect(HOME_LABEL).toBe("Home")
  })

  // W1-01: the legacy "Trust Run" label is retired from user-facing copy.
  // Internal identifiers, routes, and API contracts keep their names; this
  // sweep guards the presentation layer against regressions.
  it("keeps the legacy 'Trust Run' label out of web source", () => {
    const offenders = scanWebSource((text) => text.includes("Trust Run"))
    expect(offenders, `legacy label found in: ${offenders.join(", ")}`).toEqual([])
  })

  // Deep Review v16 3.2: the product vocabulary is Target / Finding / Scan /
  // Connection. The retired nouns below must not reappear in user-visible
  // string literals. The scan is heuristic on purpose (no parser): it reads
  // quoted strings in dashboard source and ignores identifiers, comments
  // (stripped), and non-user-facing directories. Onboarding is excluded — a
  // sibling task owns its "Product" copy, and this test must not block on it.
  // The API route directory is excluded too: it is machine-facing JSON, not
  // dashboard copy, and its error messages legitimately describe resources.
  it("keeps retired run/issue nouns out of user-visible dashboard strings", () => {
    const offenders = scanWebSource((text, filePath) => {
      const relative = filePath.replaceAll("\\", "/")
      if (relative.includes("/onboarding/")) return false
      if (relative.includes("/app/api/")) return false
      return /\b(Runs|Issues)\b/.test(text)
    })
    expect(offenders, `retired nouns found in: ${offenders.join(", ")}`).toEqual([])
  })

  it("keeps the retired Product noun out of user-visible dashboard strings", () => {
    const offenders = scanWebSource((text, filePath) => {
      const relative = filePath.replaceAll("\\", "/")
      if (relative.includes("/onboarding/")) return false
      if (relative.includes("/app/api/")) return false
      // terminology.ts is the label definition module: PRODUCT_SINGULAR lives
      // there and is consumed only by onboarding, which the sibling task owns.
      if (relative.endsWith("/lib/terminology.ts")) return false
      return /\bProducts?\b/.test(text)
    })
    expect(offenders, `retired noun found in: ${offenders.join(", ")}`).toEqual([])
  })
})

/**
 * Walk the web app's presentation source (app routes, components, this lib
 * directory), strip comments, and hand each quoted string literal to `match`.
 * Returns the files whose string literals match — heuristic, tuned to the
 * false-positive rate of this codebase (see the per-call exclusions above).
 */
function scanWebSource(match: (text: string, filePath: string) => boolean): string[] {
  const roots = [join(__dirname, "..", "app"), join(__dirname, "..", "components"), __dirname]
  const offenders: string[] = []
  const walk = (dir: string) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const text = readFileSync(full, "utf8")
        const hit = collectStringLiterals(text).some((literal) => match(literal, full))
        if (hit) offenders.push(full)
      }
    }
  }
  for (const root of roots) walk(root)
  return offenders
}

/** Quoted string literals with their comments stripped. */
function collectStringLiterals(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  const literals: string[] = []
  const pattern = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g
  for (const m of withoutComments.matchAll(pattern)) {
    const value = m[1] ?? m[2]
    if (value) literals.push(value)
  }
  return literals
}
