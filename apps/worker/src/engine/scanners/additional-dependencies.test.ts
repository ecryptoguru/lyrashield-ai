import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveExactDependencies } from "./resolved-dependencies"
import { ADDITIONAL_DEPENDENCY_INPUTS } from "./additional-dependencies"
import { DEPENDENCY_RESOLUTION_CAPABILITIES } from "@lyrashield/types"
const roots: string[] = []
async function repo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "lyrashield-ecosystems-"))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const cargo = `version = 4
[[package]]
name = "serde"
version = "1.0.219"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"
`
const ruby = `GEM
  remote: https://rubygems.org/
  specs:
    rack (3.1.8)
    ffi (1.17.0-x86_64-linux-gnu)
    ffi (1.17.0-arm64-darwin)

PLATFORMS
  ruby
  x86_64-linux-gnu
  arm64-darwin

DEPENDENCIES
  rack
  ffi
`
describe("additional exact dependency inventory", () => {
  it.each([
    cargo.replace('version = "1.0.219"', 'version = "1.0.219garbage"'),
    `${cargo}dependencies = ["child 1.0.0 (registry+https://private.example/index)"]\n${cargo.replace('name = "serde"', 'name = "child"').replace('version = "1.0.219"', 'version = "1.0.0"').replace("version = 4\n", "")}`,
  ])(
    "never qualifies malformed Cargo versions or missing source identities as complete",
    async (lock) => {
      const inventory = await resolveExactDependencies({
        repoPath: await repo({ "Cargo.lock": lock }),
      })
      expect(inventory.status).not.toBe("COMPLETE")
      expect(inventory.unresolved.length).toBeGreaterThan(0)
    }
  )

  it("preserves source/platform/path identity and checksum-bound evidence", async () => {
    const inventory = await resolveExactDependencies({
      repoPath: await repo({
        "Cargo.toml": '[dependencies]\nserde="1"\n',
        "Cargo.lock": cargo,
        Gemfile: "gem 'rack'",
        "Gemfile.lock": ruby,
        "nested/Gemfile.lock": ruby,
      }),
    })
    expect(inventory.status).toBe("COMPLETE")
    expect(inventory.packages).toHaveLength(7)
    expect(inventory.packages.filter((p) => p.name === "ffi").map((p) => p.platform)).toEqual([
      "x86_64-linux-gnu",
      "arm64-darwin",
      "x86_64-linux-gnu",
      "arm64-darwin",
    ])
    const evidence = JSON.parse(inventory.evidenceFile.content)
    expect(evidence.inputs).toHaveLength(5)
    expect(
      evidence.inputs.every((input: { sha256: string }) => /^[a-f0-9]{64}$/.test(input.sha256))
    ).toBe(true)
    expect(evidence.packages).toHaveLength(7)
  })
  it("does not let mixed npm repositories hide missing lockfiles or go.sum-only inputs", async () => {
    for (const file of ["Cargo.toml", "Gemfile", "go.sum"]) {
      const inventory = await resolveExactDependencies({
        repoPath: await repo({
          "package-lock.json": JSON.stringify({
            packages: { "node_modules/lodash": { version: "4.17.21" } },
          }),
          [file]: "not an exact lockfile",
        }),
      })
      expect(inventory.status).toBe("PARTIAL")
      expect(inventory.packages).toHaveLength(1)
      expect(inventory.unresolved.length).toBeGreaterThan(0)
    }
  })
  it("marks symlink and oversized inputs incomplete alongside readable locks", async () => {
    const root = await repo({ "Cargo.lock": cargo, "Gemfile.lock": "x".repeat(512 * 1024 + 1) })
    await symlink("Cargo.lock", join(root, "go.mod"))
    const inventory = await resolveExactDependencies({ repoPath: root })
    expect(inventory.status).toBe("PARTIAL")
    expect(inventory.truncated).toBe(true)
    expect(inventory.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "go.mod" }),
        expect.objectContaining({ name: "Gemfile.lock" }),
      ])
    )
  })
  it("keeps runtime discovered inputs aligned with the shared capability contract", () => {
    for (const capability of DEPENDENCY_RESOLUTION_CAPABILITIES.filter((c) =>
      ["Go", "crates.io", "RubyGems"].includes(c.ecosystem)
    ))
      for (const input of capability.inputs)
        expect(ADDITIONAL_DEPENDENCY_INPUTS.has(input)).toBe(true)
    expect(DEPENDENCY_RESOLUTION_CAPABILITIES.find((c) => c.ecosystem === "Maven")?.method).toBe(
      "unsupported"
    )
  })
  it("does not assume a nested Cargo manifest belongs to an ancestor workspace", async () => {
    const inventory = await resolveExactDependencies({
      repoPath: await repo({
        "Cargo.lock": cargo,
        "unrelated/Cargo.toml": '[dependencies]\ntokio="1"\n',
      }),
    })
    expect(inventory.status).toBe("PARTIAL")
    expect(inventory.unresolved).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "unrelated/Cargo.toml" })])
    )
  })
  it("preserves exact package-name identity rather than folding case", async () => {
    const inventory = await resolveExactDependencies({
      repoPath: await repo({
        "Gemfile.lock": ruby.replace("    rack (3.1.8)", "    rack (3.1.8)\n    Rack (3.1.8)"),
      }),
    })
    expect(
      inventory.packages.filter((pkg) => pkg.name.toLowerCase() === "rack").map((pkg) => pkg.name)
    ).toEqual(["rack", "Rack"])
  })
})
