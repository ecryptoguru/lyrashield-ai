import { describe, expect, it } from "vitest"
import { parseCargoLock, parseGemfileLock } from "./ecosystem-lock-parsers"

describe("exact ecosystem lockfile identities", () => {
  it("retains registry Cargo versions, checksums and source while rejecting git/path/private", () => {
    const result = parseCargoLock(
      `version = 4
[[package]]
name = "serde"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"
[[package]]
name = "local"
version = "0.1.0"
[[package]]
name = "git-dep"
version = "1.0.0"
source = "git+https://example.com/repo#abc"
[[package]]
name = "private"
version = "1.0.0"
source = "registry+https://private.example/index"
`,
      "Cargo.lock"
    )
    expect(result.packages).toEqual([
      expect.objectContaining({
        name: "serde",
        version: "1.0.219",
        ecosystem: "crates.io",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        checksum: "a".repeat(64),
      }),
    ])
    expect(result.unresolved).toHaveLength(3)
  })
  it("rejects malformed and unsupported Cargo locks and missing registry checksums", () => {
    for (const input of [
      "broken = [",
      "version=99\npackage=[]",
      'version=4\n[[package]]\nname="x"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"',
    ]) {
      const result = parseCargoLock(input, "Cargo.lock")
      expect(result.packages).toEqual([])
      expect(result.unresolved.length).toBeGreaterThan(0)
    }
  })
  it("preserves Ruby platform identities without making them OSV versions", () => {
    const result = parseGemfileLock(
      `GEM
  remote: https://rubygems.org/
  specs:
    nokogiri (1.18.8-arm64-darwin)
      racc (~> 1.4)
    nokogiri (1.18.8-x86_64-linux-gnu)
    rack (3.1.8)
    racc (1.8.1)

PLATFORMS
  arm64-darwin
  x86_64-linux-gnu
  ruby

DEPENDENCIES
  nokogiri
  rack

BUNDLED WITH
   2.6.3
`,
      "Gemfile.lock"
    )
    expect(result.unresolved).toEqual([])
    expect(result.packages.map((p) => [p.name, p.version, p.platform])).toEqual([
      ["nokogiri", "1.18.8", "arm64-darwin"],
      ["nokogiri", "1.18.8", "x86_64-linux-gnu"],
      ["rack", "3.1.8", "ruby"],
      ["racc", "1.8.1", "ruby"],
    ])
  })
  it("does not attribute git/path/private gems to RubyGems", () => {
    for (const kind of ["GIT", "PATH", "GEM"]) {
      const result = parseGemfileLock(
        `${kind}\n  remote: https://private.example/\n  specs:\n    rack (3.1.8)\n\nPLATFORMS\n  ruby\n`,
        "Gemfile.lock"
      )
      expect(result.packages).toEqual([])
      expect(result.unresolved.length).toBeGreaterThan(0)
    }
  })
  it("fails closed for ambiguous Ruby registries, unlisted platforms and malformed specs", () => {
    for (const extra of ["  remote: https://private.example/\n", ""]) {
      const result = parseGemfileLock(
        `GEM\n  remote: https://rubygems.org/\n${extra}  specs:\n    rack (3.1.8-unknown-linux)\n    broken\n\nPLATFORMS\n  ruby\n`,
        "Gemfile.lock"
      )
      expect(result.packages).toEqual([])
      expect(result.unresolved.length).toBeGreaterThan(0)
    }
  })
  it("rejects a second registry even when its remote is written after a spec", () => {
    const parsed = parseGemfileLock(
      "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.1.8)\n  remote: https://private.example/\n\nPLATFORMS\n  ruby\n",
      "Gemfile.lock"
    )
    expect(parsed.packages).toEqual([])
    expect(parsed.unresolved.length).toBeGreaterThan(0)
  })
  it("keeps missing transitive lock entries incomplete", () => {
    const cargo = parseCargoLock(
      `version=4
[[package]]
name="serde"
version="1.0.219"
source="registry+https://github.com/rust-lang/crates.io-index"
checksum="${"a".repeat(64)}"
dependencies=["missing 1.0.0"]
`,
      "Cargo.lock"
    )
    expect(cargo.unresolved.length).toBeGreaterThan(0)
    const ruby = parseGemfileLock(
      "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.1.8)\n      missing (~> 1.0)\n\nPLATFORMS\n  ruby\n",
      "Gemfile.lock"
    )
    expect(ruby.unresolved.length).toBeGreaterThan(0)
  })
})
