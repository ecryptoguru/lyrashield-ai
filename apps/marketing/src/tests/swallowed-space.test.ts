import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Swallowed-space guard.
 *
 * In Astro (and JSX) a newline between two children is not whitespace: the
 * compiler drops it. When a line of prose ends and the next line opens with an
 * element, the two render with nothing between them:
 *
 *   <p>
 *     reach us through the
 *     <a href="/support">support page</a>.
 *   </p>
 *
 * rendered as "reach us through thesupport page." The bug is invisible in the
 * source, survives `astro check` and survives a build, so it is caught here.
 * The fix is `{" "}` at the end of the text line.
 *
 * This shape was live on fifteen pages before this guard existed, including
 * /terms ("OurPrivacy page explains how we handle data") and thirteen
 * /docs/integrations guides.
 *
 * Scope is deliberate. Only the multi-line case is checked, and only for the
 * inline elements that carry no layout of their own. A one-line
 * `<span class="mr-1.5">←</span>All tools` is not flagged: the margin on the
 * span supplies the gap. The multi-line case has no such escape hatch.
 */

const INLINE_TAGS = "a|strong|em|b|code|span|abbr|time|small"

/** A line of visible text ending in a word character, followed by an element. */
const TEXT_THEN_TAG = /[A-Za-z0-9]$/
const OPENS_WITH_TAG = new RegExp(`^<(${INLINE_TAGS})\\b`)

/** An element closed at the end of a line, followed by visible text. */
const TAG_THEN_TEXT = new RegExp(`</(${INLINE_TAGS})>$`)
const OPENS_WITH_TEXT = /^[A-Za-z0-9]/

/**
 * Escape hatch for a pair that is intentionally flush. Add the marker to the
 * first line with a reason; it is not a way to silence the check quietly.
 */
const OPT_OUT = "swallow-ok"

const MARKETING_SRC = join(import.meta.dirname, "..")

function astroFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "content") continue
      astroFiles(full, found)
      continue
    }
    if (name.endsWith(".astro")) found.push(full)
  }
  return found
}

interface Violation {
  line: number
  kind: string
  before: string
  after: string
}

function findSwallowedSpaces(source: string): Violation[] {
  const violations: Violation[] = []
  const lines = source.split("\n")
  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = (lines[index] ?? "").trimEnd()
    const next = (lines[index + 1] ?? "").trim()
    if (current.includes(OPT_OUT)) continue
    const textThenTag = TEXT_THEN_TAG.test(current) && OPENS_WITH_TAG.test(next)
    const tagThenText = TAG_THEN_TEXT.test(current) && OPENS_WITH_TEXT.test(next)
    if (!textThenTag && !tagThenText) continue
    violations.push({
      line: index + 1,
      kind: textThenTag ? "text then element" : "element then text",
      before: current.trim().slice(-60),
      after: next.slice(0, 60),
    })
  }
  return violations
}

const files = astroFiles(MARKETING_SRC)

describe("swallowed spaces between a text line and an inline element", () => {
  it("scans the marketing page templates", () => {
    // Guards against the scan silently walking an empty tree.
    expect(files.length).toBeGreaterThan(40)
  })

  it("reports a pair the compiler would join", () => {
    // The detector is proven on the shape it exists to catch.
    const source = [
      "<p>",
      "  reach us through the",
      '  <a href="/support">support page</a>.',
      "</p>",
    ].join("\n")
    expect(findSwallowedSpaces(source)).toEqual([
      {
        line: 2,
        kind: "text then element",
        before: "reach us through the",
        after: '<a href="/support">support page</a>.',
      },
    ])
  })

  it("reports the reverse pair, an element followed by text", () => {
    const source = [
      "<p>",
      '  <a href="/blog/goose-mcp-security-workflow">Goose MCP workflow</a>',
      "  explains how scan results and retests fit that review.",
      "</p>",
    ].join("\n")
    const violations = findSwallowedSpaces(source)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.line).toBe(2)
    expect(violations[0]?.kind).toBe("element then text")
    expect(violations[0]?.after).toBe("explains how scan results and retests fit that review.")
  })

  it("accepts the same pairs once the space is explicit", () => {
    const textThenTag = [
      "<p>",
      '  reach us through the{" "}',
      '  <a href="/support">support page</a>.',
      "</p>",
    ].join("\n")
    const tagThenText = [
      "<p>",
      '  <a href="/blog/goose-mcp-security-workflow">Goose MCP workflow</a>{" "}',
      "  explains how scan results and retests fit that review.",
      "</p>",
    ].join("\n")
    expect(findSwallowedSpaces(textThenTag)).toEqual([])
    expect(findSwallowedSpaces(tagThenText)).toEqual([])
  })

  it.each(files.map((file) => [file.slice(MARKETING_SRC.length + 1), file] as const))(
    "%s joins its text and its inline elements with a space",
    (relative, file) => {
      const violations = findSwallowedSpaces(readFileSync(file, "utf8"))
      expect(
        violations.map((v) => `${relative}:${v.line} ${v.kind} |${v.before}| |${v.after}|`)
      ).toEqual([])
    }
  )
})
