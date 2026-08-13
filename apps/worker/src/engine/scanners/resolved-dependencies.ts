/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { dirname, join, relative } from "path"
import type { OsvQueryPackage } from "@lyrashield/db"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

export interface ResolvedDependencyInventory {
  status: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
  packages: OsvQueryPackage[]
  unresolved: Array<{ ecosystem: string; name: string; reason: string }>
  truncated: boolean
  evidenceFile: {
    path: string
    content: string
    size: number
    extension: string
    language: "json" | "yaml" | "unknown"
  }
}

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
])
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "requirements.lock",
])
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_DEPENDENCIES = 500

function packageNameFromNodeModulesPath(path: string): string | undefined {
  const marker = "node_modules/"
  const index = path.lastIndexOf(marker)
  if (index < 0) return undefined
  const rest = path.slice(index + marker.length)
  if (!rest || rest.includes("/node_modules/")) return undefined
  const parts = rest.split("/")
  return rest.startsWith("@")
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0]
}

function parsePackageLock(content: string, filePath: string): OsvQueryPackage[] {
  try {
    const lock = JSON.parse(content) as { packages?: Record<string, { version?: unknown }> }
    return Object.entries(lock.packages ?? []).flatMap(([path, value]) => {
      const name = packageNameFromNodeModulesPath(path)
      return name && typeof value.version === "string" && value.version
        ? [{ name, version: value.version, ecosystem: "npm" as const, filePath }]
        : []
    })
  } catch {
    return []
  }
}

function parsePnpmLock(content: string, filePath: string): OsvQueryPackage[] {
  const packages: OsvQueryPackage[] = []
  for (const match of content.matchAll(
    /^\s{2}['"]?((?:@[^/\s]+\/)?[^@'"\s]+)@([0-9][^:'"\s(]*)(?:\([^)]*\))?['"]?:\s*$/gm
  )) {
    if (match[1] && match[2]) {
      packages.push({ name: match[1], version: match[2], ecosystem: "npm", filePath })
    }
  }
  return packages
}

function parseYarnLock(content: string, filePath: string): OsvQueryPackage[] {
  const packages: OsvQueryPackage[] = []
  const lines = content.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const header = /^['"]?((?:@[^/\s]+\/)?[^@,'"\s]+)@[^:]+/.exec(lines[index] ?? "")
    if (!header?.[1]) continue
    const version = /^\s+version\s+['"]([^'"]+)['"]\s*$/.exec(lines[index + 1] ?? "")?.[1]
    if (version) packages.push({ name: header[1], version, ecosystem: "npm", filePath })
  }
  return packages
}

function parsePinnedRequirements(
  content: string,
  filePath: string,
  unresolved: ResolvedDependencyInventory["unresolved"]
): OsvQueryPackage[] {
  const packages: OsvQueryPackage[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("-")) continue
    const pinned = /^([A-Za-z0-9_.-]+)\s*==\s*([A-Za-z0-9_.!+-]+)$/.exec(line)
    if (!pinned?.[1] || !pinned[2]) {
      unresolved.push({
        ecosystem: "PyPI",
        name: filePath,
        reason: "dependency is not pinned to an exact version",
      })
      continue
    }
    packages.push({
      name: pinned[1].toLowerCase(),
      version: pinned[2],
      ecosystem: "PyPI",
      filePath,
    })
  }
  return packages
}

function declaredNpmDependencies(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (section) => {
        const value = parsed[section]
        return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []
      }
    )
  } catch {
    return []
  }
}

function languageFor(filename: string): "json" | "yaml" | "unknown" {
  if (filename.endsWith(".json")) return "json"
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) return "yaml"
  return "unknown"
}

export async function resolveExactDependencies({
  repoPath,
  coverageIssues,
  signal,
}: {
  repoPath: string
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
}): Promise<ResolvedDependencyInventory> {
  const packages: OsvQueryPackage[] = []
  const unresolved: ResolvedDependencyInventory["unresolved"] = []
  const packageJsonByDirectory = new Map<string, string[]>()
  const lockDirectories = new Set<string>()
  let evidenceFile: ResolvedDependencyInventory["evidenceFile"] = {
    path: "dependency-lockfile",
    content: "",
    size: 0,
    extension: ".json",
    language: "json",
  }
  let foundSupported = false
  let truncated = false

  async function walk(directory: string, depth: number, state: { entries: number }): Promise<void> {
    if (signal?.aborted) throw new Error("Dependency resolution cancelled")
    if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
      truncated = true
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "bounded",
        reason: "Dependency resolution reached its bounded repository walk limit",
      })
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
    } catch {
      return
    }
    for (const entry of entries) {
      if (signal?.aborted) throw new Error("Dependency resolution cancelled")
      if (++state.entries > MAX_WALK_ENTRIES) {
        truncated = true
        return
      }
      const fullPath = join(directory, entry.name)
      let stat
      try {
        stat = await lstat(fullPath)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(fullPath, depth + 1, state)
        continue
      }
      if (!stat.isFile()) continue
      const filePath = relative(repoPath, fullPath)
      if (entry.name === "package.json") {
        try {
          packageJsonByDirectory.set(
            dirname(filePath),
            declaredNpmDependencies(await readFile(fullPath, "utf8"))
          )
        } catch {
          unresolved.push({
            ecosystem: "npm",
            name: filePath,
            reason: "dependency manifest could not be read",
          })
        }
        continue
      }
      if (!LOCKFILES.has(entry.name)) continue
      foundSupported = true
      try {
        const content = await readFile(fullPath, "utf8")
        if (evidenceFile.path === "dependency-lockfile") {
          evidenceFile = {
            path: filePath,
            content,
            size: content.length,
            extension: fullPath.slice(fullPath.lastIndexOf(".")),
            language: languageFor(entry.name),
          }
        }
        if (entry.name === "requirements.txt" || entry.name === "requirements.lock") {
          packages.push(...parsePinnedRequirements(content, filePath, unresolved))
        } else {
          lockDirectories.add(dirname(filePath))
          const parsed =
            entry.name === "pnpm-lock.yaml"
              ? parsePnpmLock(content, filePath)
              : entry.name === "yarn.lock"
                ? parseYarnLock(content, filePath)
                : parsePackageLock(content, filePath)
          if (parsed.length === 0) {
            unresolved.push({
              ecosystem: "npm",
              name: filePath,
              reason: "no exact resolved dependencies could be parsed",
            })
          }
          packages.push(...parsed)
        }
      } catch {
        unresolved.push({
          ecosystem: "unknown",
          name: filePath,
          reason: "dependency lockfile could not be read",
        })
      }
    }
  }

  await walk(repoPath, 0, { entries: 0 })
  if (!foundSupported) {
    unresolved.push({
      ecosystem: "unknown",
      name: "dependency-lockfile",
      reason: "no supported dependency lockfile or pinned Python requirements file was found",
    })
  }
  for (const [directory, declarations] of packageJsonByDirectory) {
    if (!lockDirectories.has(directory)) continue
    const resolved = new Set(
      packages
        .filter((pkg) => dirname(pkg.filePath) === directory && pkg.ecosystem === "npm")
        .map((pkg) => pkg.name)
    )
    for (const name of declarations) {
      if (!resolved.has(name)) {
        unresolved.push({
          ecosystem: "npm",
          name,
          reason: `not resolved by the lockfile in ${directory || "."}`,
        })
      }
    }
  }

  const unique = [
    ...new Map(
      packages.map((pkg) => [`${pkg.ecosystem}:${pkg.name.toLowerCase()}@${pkg.version}`, pkg])
    ).values(),
  ]
  if (unique.length > MAX_DEPENDENCIES) {
    unresolved.push({
      ecosystem: "unknown",
      name: "dependency-inventory",
      reason: `dependency limit reached (${MAX_DEPENDENCIES})`,
    })
    truncated = true
  }
  const bounded = unique.slice(0, MAX_DEPENDENCIES)
  return {
    status:
      bounded.length > 0 && unresolved.length === 0 && !truncated
        ? "COMPLETE"
        : bounded.length > 0
          ? "PARTIAL"
          : "UNSUPPORTED",
    packages: bounded,
    unresolved,
    truncated,
    evidenceFile,
  }
}
