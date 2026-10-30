import { parse as parseToml } from "@iarna/toml"
import { z } from "zod"
import type { OsvQueryPackage } from "@lyrashield/db"

/** Source and platform distinguish evidence even when OSV shares the advisory key. */
export interface ResolvedPackageIdentity extends OsvQueryPackage {
  source?: string
  platform?: string
  checksum?: string
  replaces?: { name: string; version?: string }
}
export interface EcosystemResolution {
  packages: ResolvedPackageIdentity[]
  unresolved: Array<{ ecosystem: string; name: string; reason: string }>
}
const MAX_BYTES = 512 * 1024
const MAX_PACKAGES = 500
const cargoPackage = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/),
  source: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
const cargoLock = z.object({
  version: z.union([z.literal(3), z.literal(4)]),
  package: z.array(z.unknown()),
})
const CARGO_REGISTRIES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
])

export function parseCargoLock(content: string, filePath: string): EcosystemResolution {
  const result: EcosystemResolution = { packages: [], unresolved: [] }
  const issue = (reason: string, name = filePath) =>
    result.unresolved.length < MAX_PACKAGES &&
    result.unresolved.push({ ecosystem: "crates.io", name, reason })
  if (Buffer.byteLength(content) > MAX_BYTES) {
    issue("Cargo lockfile exceeds the input byte limit")
    return result
  }
  try {
    const lock = cargoLock.parse(parseToml(content))
    if (!lock.package.length) issue("Cargo lockfile contains no package identities")
    if (lock.package.length > MAX_PACKAGES) issue("Cargo lockfile exceeds the package limit")
    const entries = lock.package.slice(0, MAX_PACKAGES).map((raw) => cargoPackage.safeParse(raw))
    const names = new Set(entries.flatMap((entry) => (entry.success ? [entry.data.name] : [])))
    const versions = new Set(
      entries.flatMap((entry) =>
        entry.success ? [`${entry.data.name} ${entry.data.version}`] : []
      )
    )
    for (const parsed of entries) {
      if (!parsed.success) {
        issue("Malformed Cargo package identity")
        continue
      }
      const pkg = parsed.data
      if (!pkg.source || !CARGO_REGISTRIES.has(pkg.source) || !pkg.checksum) {
        issue(
          "Cargo git, path, private registry or unchecked package cannot be resolved as a crates.io release",
          pkg.name
        )
        continue
      }
      for (const reference of pkg.dependencies ?? []) {
        const [name, version] = reference.split(" ")
        const found = version ? versions.has(`${name} ${version}`) : names.has(name!)
        if (!found) issue("Cargo dependency has no corresponding exact lock entry", name)
      }
      result.packages.push({
        name: pkg.name,
        version: pkg.version,
        source: pkg.source,
        checksum: pkg.checksum,
        ecosystem: "crates.io",
        filePath,
      })
    }
  } catch {
    issue("Malformed or unsupported Cargo lockfile")
  }
  return result
}

export function parseGemfileLock(content: string, filePath: string): EcosystemResolution {
  const result: EcosystemResolution = { packages: [], unresolved: [] }
  const issue = (reason: string, name = filePath) =>
    result.unresolved.length < MAX_PACKAGES &&
    result.unresolved.push({ ecosystem: "RubyGems", name, reason })
  if (Buffer.byteLength(content) > MAX_BYTES) {
    issue("Ruby lockfile exceeds the input byte limit")
    return result
  }
  const lines = content.split(/\r?\n/)
  const platforms = new Set<string>()
  let section = ""
  let sectionIndex = -1
  const sectionRemotes = new Map<number, string[]>()
  for (const [index, line] of lines.entries()) {
    if (/^[A-Z][A-Z ]*$/.test(line)) {
      section = line
      sectionIndex = index
      sectionRemotes.set(index, [])
    } else if (section === "PLATFORMS" && /^  \S+$/.test(line)) platforms.add(line.trim())
    else if (["GEM", "GIT", "PATH"].includes(section) && line.startsWith("  remote: "))
      sectionRemotes.get(sectionIndex)?.push(line.slice(10))
  }
  const platformCandidates = [...platforms]
    .slice(0, MAX_PACKAGES)
    .sort((a, b) => b.length - a.length)
  if (platforms.size > MAX_PACKAGES) issue("Ruby platform limit reached")
  let sourceKind = ""
  let remotes: string[] = []
  let specs = false
  let count = 0
  const declarations: string[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    if (/^[A-Z][A-Z ]*$/.test(line)) {
      section = line
      sourceKind = ["GEM", "GIT", "PATH"].includes(section) ? section : ""
      remotes = sectionRemotes.get(index) ?? []
      specs = false
      if (
        ![
          "GEM",
          "GIT",
          "PATH",
          "PLATFORMS",
          "DEPENDENCIES",
          "RUBY VERSION",
          "BUNDLED WITH",
          "CHECKSUMS",
        ].includes(section)
      )
        issue("Unsupported Ruby lockfile section")
      continue
    }
    if (section === "DEPENDENCIES") {
      const match = /^  ([A-Za-z0-9_.-]+)/.exec(line)
      if (match?.[1]) declarations.push(match[1])
      else issue("Malformed Ruby dependency declaration")
    }
    if (!sourceKind) continue
    if (line.startsWith("  remote: ")) {
      continue
    }
    if (line === "  specs:") {
      specs = true
      continue
    }
    if (!specs) continue
    if (line.startsWith("      ")) {
      const declaration = line.trim()
      const separator = declaration.indexOf(" ")
      const dependency = separator < 0 ? declaration : declaration.slice(0, separator)
      const constraint = separator < 0 ? "" : declaration.slice(separator + 1)
      if (
        /^[A-Za-z0-9_.-]+$/.test(dependency) &&
        (!constraint ||
          (constraint.startsWith("(") &&
            constraint.endsWith(")") &&
            !/[()]/.test(constraint.slice(1, -1))))
      )
        declarations.push(dependency)
      else issue("Malformed Ruby transitive dependency")
      continue
    }
    if (++count > MAX_PACKAGES) {
      issue("Ruby lockfile exceeds the package limit")
      break
    }
    const match = /^    ([A-Za-z0-9_.-]+) \(([^()\s]+)\)$/.exec(line)
    if (!match?.[1] || !match[2]) {
      issue("Malformed Ruby locked package")
      continue
    }
    const [, name, identity] = match
    if (
      sourceKind !== "GEM" ||
      remotes.length !== 1 ||
      !["https://rubygems.org", "https://rubygems.org/"].includes(remotes[0] ?? "")
    ) {
      issue(
        "Ruby git, path, private or ambiguous registry package cannot be resolved as a RubyGems release",
        name
      )
      continue
    }
    const platform =
      platformCandidates.find((p) => p !== "ruby" && identity.endsWith(`-${p}`)) ?? "ruby"
    const version = platform === "ruby" ? identity : identity.slice(0, -platform.length - 1)
    if (!/^\d+[A-Za-z0-9.]*$/.test(version) || !platforms.size) {
      issue("Ruby version or platform identity could not be resolved", name)
      continue
    }
    result.packages.push({
      name,
      version,
      platform,
      source: "https://rubygems.org/",
      ecosystem: "RubyGems",
      filePath,
    })
  }
  if (!count) issue("Ruby lockfile contains no package identities")
  const resolvedNames = new Set(result.packages.map((p) => p.name))
  for (const name of declarations)
    if (!resolvedNames.has(name))
      issue("Ruby dependency is not resolved by a public registry lock entry", name)
  return result
}
