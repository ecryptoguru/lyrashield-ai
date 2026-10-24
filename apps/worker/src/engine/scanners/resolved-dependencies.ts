/* eslint-disable security/detect-non-literal-fs-filename */
import { lstat, readFile, readdir } from "fs/promises"
import { dirname, join, relative } from "path"
import type { OsvQueryPackage } from "@lyrashield/db"
import { parsePackageLock, parsePnpmLock, parseYarnLock } from "./dependency-lock-parsers"
import {
  composerContentHash,
  composerRequirements,
  parseComposerLock,
  parseComposerManifest,
} from "./composer-dependencies"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import { isExcludedPhpPath } from "./php-project"

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
  "composer.lock",
])
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_DEPENDENCIES = 500
const MAX_COMPOSER_FILE_BYTES = 512 * 1024

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
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dependency manifest must be an object")
  }
  const manifest = parsed as Record<string, unknown>
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
    (section) => {
      const value = manifest[section]
      if (value === undefined) return []
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Dependency manifest section must be an object")
      }
      return Object.keys(value)
    }
  )
}

function languageFor(filename: string): "json" | "yaml" | "unknown" {
  if (filename.endsWith(".json")) return "json"
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) return "yaml"
  return "unknown"
}

interface DependencyInputs {
  repoPath: string
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
  packages: OsvQueryPackage[]
  unresolved: ResolvedDependencyInventory["unresolved"]
  packageJsonByDirectory: Map<string, string[]>
  lockDirectories: Set<string>
  composerManifests: Map<string, Record<string, unknown>>
  composerLocks: Map<string, unknown>
  evidenceFile: ResolvedDependencyInventory["evidenceFile"]
  foundSupported: boolean
  truncated: boolean
}

function eligibleDependencyEntries<T extends { name: string }>(
  entries: T[],
  root: string,
  directory: string
): T[] {
  return entries.filter(
    (entry) =>
      !(
        ["composer.json", "composer.lock"].includes(entry.name) &&
        isExcludedPhpPath(relative(root, join(directory, entry.name)))
      )
  )
}

async function walkDependencyInputs(
  directory: string,
  depth: number,
  state: { entries: number },
  context: DependencyInputs
): Promise<void> {
  const {
    repoPath,
    coverageIssues,
    signal,
    packages,
    unresolved,
    packageJsonByDirectory,
    lockDirectories,
    composerManifests,
    composerLocks,
  } = context
  if (signal?.aborted) throw new Error("Dependency resolution cancelled")
  if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
    context.truncated = true
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
    unresolved.push({
      ecosystem: "unknown",
      name: relative(repoPath, directory) || ".",
      reason: "repository directory could not be read",
    })
    return
  }
  for (const entry of eligibleDependencyEntries(entries, repoPath, directory)) {
    if (signal?.aborted) throw new Error("Dependency resolution cancelled")
    if (++state.entries > MAX_WALK_ENTRIES) {
      context.truncated = true
      return
    }
    const fullPath = join(directory, entry.name)
    let stat
    try {
      stat = await lstat(fullPath)
    } catch {
      unresolved.push({
        ecosystem: "unknown",
        name: relative(repoPath, fullPath),
        reason: "repository path could not be read",
      })
      continue
    }
    if (stat.isSymbolicLink()) {
      if (entry.name === "composer.json" || entry.name === "composer.lock") {
        unresolved.push({
          ecosystem: "Packagist",
          name: relative(repoPath, fullPath),
          reason: "Composer dependency path is a symbolic link and was not read",
        })
      }
      continue
    }
    if (stat.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name))
        await walkDependencyInputs(fullPath, depth + 1, state, context)
      continue
    }
    if (!stat.isFile()) continue
    const filePath = relative(repoPath, fullPath)
    const isComposerFile = entry.name === "composer.json" || entry.name === "composer.lock"
    if (isComposerFile && stat.size > MAX_COMPOSER_FILE_BYTES) {
      unresolved.push({
        ecosystem: "Packagist",
        name: filePath,
        reason: `dependency input exceeds the ${MAX_COMPOSER_FILE_BYTES}-byte scanner limit`,
      })
      context.truncated = true
      continue
    }
    if (entry.name === "composer.json") {
      try {
        composerManifests.set(
          dirname(filePath),
          parseComposerManifest(await readFile(fullPath, "utf8"))
        )
      } catch {
        unresolved.push({
          ecosystem: "Packagist",
          name: filePath,
          reason: "Composer dependency manifest could not be read or parsed",
        })
      }
      continue
    }
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
    context.foundSupported = true
    try {
      const content = await readFile(fullPath, "utf8")
      if (context.evidenceFile.path === "dependency-lockfile") {
        context.evidenceFile = {
          path: filePath,
          content,
          size: content.length,
          extension: fullPath.slice(fullPath.lastIndexOf(".")),
          language: languageFor(entry.name),
        }
      }
      if (entry.name === "composer.lock") {
        const parsed = parseComposerLock(content, filePath, unresolved)
        packages.push(...parsed.packages)
        composerLocks.set(dirname(filePath), parsed.contentHash)
      } else if (entry.name === "requirements.txt" || entry.name === "requirements.lock") {
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

function checkComposerConsistency({
  packages,
  unresolved,
  composerManifests,
  composerLocks,
}: DependencyInputs): void {
  for (const [directory, manifest] of composerManifests) {
    const filePath = join(directory, "composer.json")
    const names = composerRequirements(manifest, filePath, unresolved)
    const lockedNames = new Set(
      packages
        .filter((pkg) => pkg.ecosystem === "Packagist" && dirname(pkg.filePath) === directory)
        .map((pkg) => pkg.name)
    )
    for (const name of names) {
      if (!lockedNames.has(name))
        unresolved.push({
          ecosystem: "Packagist",
          name,
          reason: `not resolved by the lockfile in ${directory || "."}`,
        })
    }
    const hash = composerLocks.get(directory)
    let current = false
    try {
      current =
        typeof hash === "string" &&
        /^[a-f0-9]{32}$/.test(hash) &&
        hash === composerContentHash(manifest)
    } catch {
      // Malformed/deep input remains incomplete without dropping safe lock releases.
    }
    if (!current) {
      unresolved.push({
        ecosystem: "Packagist",
        name: filePath,
        reason:
          "Composer manifest/lockfile consistency could not be verified: missing or stale content-hash",
      })
    }
  }
  for (const directory of composerLocks.keys()) {
    if (!composerManifests.has(directory))
      unresolved.push({
        ecosystem: "Packagist",
        name: join(directory, "composer.lock"),
        reason:
          "Composer manifest is missing or unreadable; lockfile consistency could not be verified",
      })
  }
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
  const composerManifests = new Map<string, Record<string, unknown>>()
  const composerLocks = new Map<string, unknown>()
  const evidenceFile: ResolvedDependencyInventory["evidenceFile"] = {
    path: "dependency-lockfile",
    content: "",
    size: 0,
    extension: ".json",
    language: "json",
  }

  const context: DependencyInputs = {
    repoPath,
    coverageIssues,
    signal,
    packages,
    unresolved,
    packageJsonByDirectory,
    lockDirectories,
    composerManifests,
    composerLocks,
    evidenceFile,
    foundSupported: false,
    truncated: false,
  }
  await walkDependencyInputs(repoPath, 0, { entries: 0 }, context)
  const { foundSupported } = context
  let { truncated } = context
  if (!foundSupported) {
    unresolved.push({
      ecosystem: "unknown",
      name: "dependency-lockfile",
      reason: "no supported dependency lockfile or pinned Python requirements file was found",
    })
  }
  for (const [directory, declarations] of packageJsonByDirectory) {
    let lockDirectory = directory
    while (!lockDirectories.has(lockDirectory) && lockDirectory !== ".") {
      lockDirectory = dirname(lockDirectory)
    }
    const resolved = new Set(
      packages
        .filter((pkg) => dirname(pkg.filePath) === lockDirectory && pkg.ecosystem === "npm")
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

  checkComposerConsistency(context)

  const unique = [
    ...new Map(
      packages.map((pkg) => [
        JSON.stringify([
          pkg.ecosystem,
          pkg.name.toLowerCase(),
          pkg.version,
          ...(pkg.ecosystem === "Packagist" ? [pkg.filePath] : []),
        ]),
        pkg,
      ])
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
  for (const issue of unresolved) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: bounded.length ? "partial" : "unsupported",
      subject: issue.name,
      reason: issue.reason,
    })
  }
  if (truncated)
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: "bounded",
      reason: "Dependency inventory is incomplete because a scanner limit was reached",
    })
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
    evidenceFile: context.evidenceFile,
  }
}
