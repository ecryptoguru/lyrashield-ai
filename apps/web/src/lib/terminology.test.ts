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
    const roots = [
      join(__dirname, "..", "app"),
      join(__dirname, "..", "components"),
      __dirname,
    ]
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
          if (text.includes("Trust Run")) offenders.push(full)
        }
      }
    }
    for (const root of roots) walk(root)
    expect(offenders, `legacy label found in: ${offenders.join(", ")}`).toEqual([])
  })
})
