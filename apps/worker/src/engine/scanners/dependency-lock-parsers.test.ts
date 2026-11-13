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

  it("keeps pnpm entry indentation and yarn scoped descriptors precise", () => {
    expect(
      parsePnpmLock("  pkg@1.2.3(peer@5.0.0):\n    nested-dependency@4.5.6:\n", "pnpm-lock.yaml")
    ).toEqual([{ name: "pkg", version: "1.2.3", ecosystem: "npm", filePath: "pnpm-lock.yaml" }])
    expect(
      parseYarnLock('"@scope/tool@^1.0.0, @scope/tool@^2.0.0":\n  version "2.3.4"\n', "yarn.lock")
    ).toEqual([{ name: "@scope/tool", version: "2.3.4", ecosystem: "npm", filePath: "yarn.lock" }])
    expect(
      parseYarnLock(
        '"git-package@https://github.com/org/repo.git#abc":\n  version "1.2.3"\n',
        "yarn.lock"
      )
    ).toEqual([{ name: "git-package", version: "1.2.3", ecosystem: "npm", filePath: "yarn.lock" }])
    expect(parseYarnLock('"@scope/@^1.0.0":\n  version "1.2.3"\n', "yarn.lock")).toEqual([])
  })

  it("handles large valid lockfiles without dropping resolved entries", () => {
    const count = 20_000
    const packageEntries = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `node_modules/pkg-${index}`,
        { version: `1.${index}.0` },
      ])
    )
    const pnpmEntries = Array.from(
      { length: count },
      (_, index) => `  pkg-${index}@1.${index}.0:`
    ).join("\n")
    const yarnEntries = Array.from(
      { length: count },
      (_, index) => `pkg-${index}@^1.0.0:\n  version "1.${index}.0"`
    ).join("\n")

    expect(
      parsePackageLock(JSON.stringify({ packages: packageEntries }), "package-lock.json")
    ).toHaveLength(count)
    expect(parsePnpmLock(pnpmEntries, "pnpm-lock.yaml")).toHaveLength(count)
    expect(parseYarnLock(yarnEntries, "yarn.lock")).toHaveLength(count)
  })

  it("bounds work on malformed and adversarial long lockfile lines", () => {
    const long = "a".repeat(250_000)
    const pnpmNearMatch = `  '@${long}/@${long}@1.0.0':\n`
    const yarnNearMatch = `"@${long}/@${long}@^1.0.0":\n  resolved url\n`
    const malformedPackageLock = `${" ".repeat(250_000)}{${long}!`
    const startedAt = performance.now()

    expect(parsePackageLock(malformedPackageLock, "package-lock.json")).toEqual([])
    expect(parsePnpmLock(`${pnpmNearMatch}  safe-package@1.2.3:\n`, "pnpm-lock.yaml")).toEqual([
      { name: "safe-package", version: "1.2.3", ecosystem: "npm", filePath: "pnpm-lock.yaml" },
    ])
    expect(
      parseYarnLock(`${yarnNearMatch}safe-package@^1.0.0:\n  version "1.2.3"\n`, "yarn.lock")
    ).toEqual([{ name: "safe-package", version: "1.2.3", ecosystem: "npm", filePath: "yarn.lock" }])
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  })
})
