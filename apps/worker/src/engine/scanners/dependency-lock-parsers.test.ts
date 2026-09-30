import { describe, expect, it } from "vitest"
import { parsePackageLock, parsePnpmLock, parseYarnLock } from "./dependency-lock-parsers"

describe("dependency lock parsers", () => {
  it("extracts exact npm releases from supported lockfiles", () => {
    expect(
      parsePackageLock(
        JSON.stringify({
          packages: {
            "": { version: "1.0.0" },
            "node_modules/@scope/tool": { version: "2.3.4" },
            "node_modules/tool/node_modules/nested": { version: "5.6.7" },
          },
        }),
        "package-lock.json"
      )
    ).toEqual([
      { name: "@scope/tool", version: "2.3.4", ecosystem: "npm", filePath: "package-lock.json" },
      { name: "nested", version: "5.6.7", ecosystem: "npm", filePath: "package-lock.json" },
    ])

    expect(parsePnpmLock("  '@scope/tool@2.3.4':\n  plain@5.6.7:\n", "pnpm-lock.yaml")).toEqual([
      { name: "@scope/tool", version: "2.3.4", ecosystem: "npm", filePath: "pnpm-lock.yaml" },
      { name: "plain", version: "5.6.7", ecosystem: "npm", filePath: "pnpm-lock.yaml" },
    ])

    expect(parseYarnLock('"@scope/tool@^2.0.0":\n  version "2.3.4"\n', "yarn.lock")).toEqual([
      { name: "@scope/tool", version: "2.3.4", ecosystem: "npm", filePath: "yarn.lock" },
    ])
  })

  it("returns no resolved release for malformed or unpinned lock content", () => {
    expect(parsePackageLock("{broken", "package-lock.json")).toEqual([])
    expect(parsePnpmLock("  plain@^5.0.0:\n", "pnpm-lock.yaml")).toEqual([])
    expect(parseYarnLock('"plain@^5.0.0":\n  resolved "url"\n', "yarn.lock")).toEqual([])
  })
})
