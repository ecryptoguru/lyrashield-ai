/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { readFile, readdir } from "fs/promises"
import { join, relative } from "path"
import type { OsvQueryPackage } from "@lyrashield/db"
import type { AIScanFile } from "@lyrashield/security/ai-security"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import type { ResolvedDependencyInventory } from "./resolved-dependencies"
import {
  IGNORED_DIRECTORIES,
  MAX_WALK_DEPTH,
  MAX_WALK_ENTRIES,
  throwIfAborted,
} from "./ai-app-source-discovery"

export type DependencyResolution = {
  packages: OsvQueryPackage[]
  status: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
  unresolvedReasons: string[]
  evidenceFile: AIScanFile
}

export function toDependencyResolution(
  inventory: ResolvedDependencyInventory
): DependencyResolution {
  return {
    packages: inventory.packages,
    status: inventory.status,
    unresolvedReasons: inventory.unresolved.map(
      (entry) => `${entry.ecosystem}:${entry.name}: ${entry.reason}`
    ),
    evidenceFile: inventory.evidenceFile as AIScanFile,
  }
}

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
    if (match[1] && match[2])
      packages.push({ name: match[1], version: match[2], ecosystem: "npm", filePath })
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
  filePath: string
): { packages: OsvQueryPackage[]; unresolved: string[] } {
  const packages: OsvQueryPackage[] = []
  const unresolved: string[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("-")) continue
    const pinned = /^([A-Za-z0-9_.-]+)\s*==\s*([A-Za-z0-9_.!+-]+)$/.exec(line)
    if (!pinned?.[1] || !pinned[2]) {
      unresolved.push(`${filePath}: dependency is not pinned to an exact version`)
      continue
    }
    packages.push({
      name: pinned[1].toLowerCase(),
      version: pinned[2],
      ecosystem: "PyPI",
      filePath,
    })
  }
  return { packages, unresolved }
}

export async function collectDependencyPackages(
  repoPath: string,
  coverageIssues: ScannerCoverageIssue[],
  signal?: AbortSignal
): Promise<DependencyResolution> {
  const packages: OsvQueryPackage[] = []
  const unresolvedReasons: string[] = []
  let foundManifest = false
  let foundLockfile = false
  let evidenceFile: AIScanFile = {
    path: "dependency-lockfile",
    content: "",
    size: 0,
    extension: ".json",
    language: "json",
  }

  async function walk(directory: string, depth: number, state: { entries: number }): Promise<void> {
    throwIfAborted(signal)
    if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "bounded",
        reason: "Dependency manifest discovery reached its bounded repository walk limit",
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
      throwIfAborted(signal)
      if (++state.entries > MAX_WALK_ENTRIES) break
      if (entry.isSymbolicLink()) continue
      const fullPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(fullPath, depth + 1, state)
        }
        continue
      }

      if (!entry.isFile()) continue
      if (
        [
          "package-lock.json",
          "npm-shrinkwrap.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "requirements.txt",
          "requirements.lock",
        ].includes(entry.name)
      ) {
        try {
          const content = await readFile(fullPath, "utf8")
          const filePath = relative(repoPath, fullPath)
          evidenceFile = {
            path: filePath,
            content,
            size: content.length,
            extension: fullPath.slice(fullPath.lastIndexOf(".")),
            language:
              entry.name === "pnpm-lock.yaml"
                ? "yaml"
                : entry.name.startsWith("requirements")
                  ? "unknown"
                  : "json",
          }
          if (entry.name === "requirements.txt" || entry.name === "requirements.lock") {
            foundManifest = true
            const parsed = parsePinnedRequirements(content, filePath)
            packages.push(...parsed.packages)
            unresolvedReasons.push(...parsed.unresolved)
          } else {
            foundLockfile = true
            if (entry.name === "pnpm-lock.yaml") packages.push(...parsePnpmLock(content, filePath))
            else if (entry.name === "yarn.lock") packages.push(...parseYarnLock(content, filePath))
            else packages.push(...parsePackageLock(content, filePath))
            if (packages.length === 0)
              unresolvedReasons.push(`${filePath}: no exact resolved dependencies could be parsed`)
          }
        } catch {
          recordCoverageIssue(coverageIssues, {
            scanner: "ai_app_security",
            status: "partial",
            subject: relative(repoPath, fullPath),
            reason: "Could not read a dependency lockfile for AI-03 advisory scanning",
          })
          unresolvedReasons.push(`${relative(repoPath, fullPath)}: could not be read`)
        }
      }
    }
  }

  await walk(repoPath, 0, { entries: 0 })
  if (!foundLockfile && !foundManifest) {
    unresolvedReasons.push(
      "No supported dependency lockfile or pinned Python requirements file was found"
    )
  }
  const unique = [
    ...new Map(
      packages.map((pkg) => [`${pkg.ecosystem}:${pkg.name.toLowerCase()}@${pkg.version}`, pkg])
    ).values(),
  ]
  return {
    packages: unique,
    status:
      unique.length > 0 && unresolvedReasons.length === 0
        ? "COMPLETE"
        : unique.length > 0
          ? "PARTIAL"
          : "UNSUPPORTED",
    unresolvedReasons,
    evidenceFile,
  }
}
