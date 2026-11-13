import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ts from "typescript"

/**
 * Server components render in the host's locale and timezone; a bare
 * `toLocale*()` call produces different output per deployment region and a
 * hydration mismatch in any client tree. Casual dashboard dates use
 * `LocalTime` (UTC on SSR, viewer-local after mount); deterministic surfaces
 * use `Intl.DateTimeFormat` with an explicit locale and `timeZone: "UTC"`.
 */
function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      yield* sources(full)
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) {
      yield full
    }
  }
}

const appDir = new URL("./", import.meta.url).pathname

describe("locale-stable date formatting", () => {
  it("pins an explicit timezone wherever a server component formats with toLocale*", () => {
    const violations: string[] = []
    for (const file of sources(appDir)) {
      const text = readFileSync(file, "utf8")
      if (text.includes('"use client"')) continue
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /^toLocale(?:Date|Time)?String$/.test(node.expression.name.text)
        ) {
          // Inspect this call's options, never an adjacent call or comment.
          const options = node.arguments[1]
          const hasTimeZone =
            options &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                property.name.text === "timeZone"
            )
          if (!hasTimeZone) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
            violations.push(`${file}:${line + 1}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })
})
