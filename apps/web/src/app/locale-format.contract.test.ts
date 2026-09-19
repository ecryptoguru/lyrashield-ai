import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

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
  it("has no bare toLocale*() calls in server components under app/", () => {
    const violations: string[] = []
    for (const file of sources(appDir)) {
      const text = readFileSync(file, "utf8")
      if (text.includes('"use client"')) continue
      for (const match of text.matchAll(/\.toLocale(?:Date|Time)?String\(\)/g)) {
        violations.push(`${file}:${text.slice(0, match.index).split("\n").length}`)
      }
    }
    expect(violations).toEqual([])
  })

  it("pins an explicit timezone wherever a server component formats with toLocale*", () => {
    const violations: string[] = []
    for (const file of sources(appDir)) {
      const text = readFileSync(file, "utf8")
      if (text.includes('"use client"')) continue
      for (const match of text.matchAll(/\.toLocale(?:Date|Time)?String\(([^)]*)\)/g)) {
        // The options object may span lines; check the 200 chars after the call.
        const callSite = text.slice(match.index, match.index + 400)
        if (!callSite.includes("timeZone")) {
          violations.push(`${file}:${text.slice(0, match.index).split("\n").length}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
