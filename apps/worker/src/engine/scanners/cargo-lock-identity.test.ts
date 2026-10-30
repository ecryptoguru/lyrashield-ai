import { describe, expect, it } from "vitest"
import { parseCargoLock } from "./ecosystem-lock-parsers"

const registry = "registry+https://github.com/rust-lang/crates.io-index"
const sparse = "sparse+https://index.crates.io/"
function entry(name: string, version: string, source = registry, dependencies: string[] = []) {
  return `[[package]]
name = ${JSON.stringify(name)}
version = ${JSON.stringify(version)}
source = ${JSON.stringify(source)}
checksum = "${"a".repeat(64)}"
dependencies = ${JSON.stringify(dependencies)}
`
}

describe("Cargo exact SemVer identities", () => {
  it.each([
    "1.0.0garbage",
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0.1",
    "1.0.0-",
    "1.0.0+",
    "1.0.0-.alpha",
    "1.0.0-alpha..1",
    "1.0.0-alpha.",
    "1.0.0-01",
    "1.0.0-alpha.01",
    "1.0.0+build..1",
    "1.0.0+build.",
    "1.0.0+build+other",
    "1.0.0-alpha_1",
    "1.0.0\n",
    "18446744073709551616.0.0",
    "1.18446744073709551616.0",
    "1.0.18446744073709551616",
  ])("keeps malformed or Cargo-overflow version %j incomplete", (version) => {
    const result = parseCargoLock(`version = 4\n${entry("child", version)}`, "Cargo.lock")
    expect(result.packages).toEqual([])
    expect(result.unresolved.length).toBeGreaterThan(0)
  })

  it.each([
    "0.0.0",
    "1.2.3-alpha.0",
    "1.2.3-01alpha.1-2.-",
    "1.2.3+001.build-2",
    "1.2.3-alpha.1+001.build-2",
    "1.2.3-18446744073709551616",
    "18446744073709551615.18446744073709551615.18446744073709551615",
  ])("preserves the full valid Cargo version %j", (version) => {
    const result = parseCargoLock(`version = 4\n${entry("child", version)}`, "Cargo.lock")
    expect(result.packages).toEqual([expect.objectContaining({ name: "child", version })])
    expect(result.unresolved).toEqual([])
  })
})

describe("Cargo dependency reference identity", () => {
  it.each([
    "child 1.0.0 (registry+https://private.example/index)",
    `child 1.0.0 (${sparse})`,
    "child 1.0.0 trailing",
    `child 1.0.0 (${registry}) trailing`,
    "child 1.0.0 ()",
    `child 1.0.0 (${registry}`,
    "child 1.0.0 (registry+https://private.example/index extra)",
  ])("does not satisfy missing or malformed reference %j from a public child", (reference) => {
    const result = parseCargoLock(
      `version = 4\n${entry("parent", "1.0.0", registry, [reference])}${entry("child", "1.0.0")}`,
      "Cargo.lock"
    )
    expect(result.unresolved.length).toBeGreaterThan(0)
  })

  it.each([
    ["child", entry("child", "2.0.0")],
    ["child 1.0.0", entry("child", "1.0.0", sparse)],
    [`child 1.0.0 (${registry})`, entry("child", "1.0.0")],
  ])("rejects ambiguous dependency reference %j", (reference, other) => {
    const result = parseCargoLock(
      `version = 4\n${entry("parent", "1.0.0", registry, [reference])}${entry("child", "1.0.0")}${other}`,
      "Cargo.lock"
    )
    expect(result.unresolved.length).toBeGreaterThan(0)
  })

  it.each(["child", "child 1.0.0", `child 1.0.0 (${registry})`])(
    "resolves the unambiguous reference %j",
    (reference) => {
      const result = parseCargoLock(
        `version = 4\n${entry("parent", "1.0.0", registry, [reference])}${entry("child", "1.0.0")}`,
        "Cargo.lock"
      )
      expect(result.unresolved).toEqual([])
      expect(result.packages).toHaveLength(2)
    }
  )

  it("uses one complete identity when source/version qualifiers disambiguate public entries", () => {
    const version = "1.0.0-alpha.1+build.001"
    const result = parseCargoLock(
      `version = 4\n${entry("parent", "1.0.0", registry, [`child ${version} (${sparse})`])}${entry("child", version, sparse)}${entry("child", version)}${entry("child", "2.0.0", sparse)}`,
      "Cargo.lock"
    )
    expect(result.unresolved).toEqual([])
    expect(result.packages).toHaveLength(4)
  })
})
