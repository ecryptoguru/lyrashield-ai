import { describe, expect, it } from "vitest"
import { selectFixedVersion } from "./advisory-fixed-version"
import type { OsvVulnerability } from "@lyrashield/db"

const dependency = {
  ecosystem: "npm",
  name: "widget",
  version: "1.5.0",
  filePath: "package-lock.json",
}
const affected = {
  package: { ecosystem: "npm", name: "widget" },
  ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.9.0" }] }],
}

describe("conservative advisory upgrades", () => {
  it("withholds a recommendation when another applicable entry has no assessable ranges", () => {
    expect(
      selectFixedVersion(
        { id: "GHSA-ambiguous", affected: [affected, { package: affected.package }] },
        dependency
      )
    ).toBeUndefined()
  })
  it("rejects invalid leading-zero npm releases instead of numerically coercing semver", () => {
    expect(
      selectFixedVersion(
        { id: "GHSA-invalid", affected: [affected] },
        { ...dependency, version: "1.05.0" }
      )
    ).toBeUndefined()
  })
  it("does not recommend a fixed boundary that another interval still affects", () => {
    const vulnerability: OsvVulnerability = {
      id: "GHSA-overlap",
      affected: [
        {
          ...affected,
          ranges: [
            ...affected.ranges,
            { type: "SEMVER", events: [{ introduced: "1.8.0" }, { fixed: "2.0.0" }] },
          ],
        },
      ],
    }
    expect(selectFixedVersion(vulnerability, dependency)).toBeUndefined()
  })
  it("withholds malformed partial npm SEMVER boundaries", () => {
    expect(
      selectFixedVersion(
        {
          id: "GHSA-partial",
          affected: [
            {
              ...affected,
              ranges: [{ type: "SEMVER", events: [{ introduced: "1.0" }, { fixed: "1.9.0" }] }],
            },
          ],
        },
        dependency
      )
    ).toBeUndefined()
  })
})
