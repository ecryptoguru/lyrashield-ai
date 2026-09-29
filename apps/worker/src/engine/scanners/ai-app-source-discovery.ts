/* eslint-disable security/detect-non-literal-fs-filename */
import { lstat, readFile, readdir } from "fs/promises"
import { join, relative, sep } from "path"
import type { AIScanFile, AIScanLimit } from "@lyrashield/security/ai-security"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

export interface AiAppSecurityDiscoveryReceipt {
  version: "ai-app-security-discovery/1"
  mode: "QUICK" | "STANDARD" | "DEEP"
  maxFiles: number
  eligibleFiles: number
  scannedFiles: number
  skippedFiles: number
  scannedBytes: number
  representativeSkippedPaths: string[]
  skippedByReason: {
    fileLimit: number
    totalByteLimit: number
    oversized: number
    unreadable: number
  }
  limitsReached: AIScanLimit[]
}

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".html",
  ".htm",
  ".py",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
])

const WEBMCP_CONFIG_FILES = new Set(["_headers", ".htaccess", "nginx.conf", "vercel.json"])

export const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".astro",
  ".cache",
  ".nyc_output",
  ".playwright-mcp",
  ".turbo",
  ".vercel",
  "playwright-report",
  "test-results",
])

const MAX_FILES_BY_MODE = {
  QUICK: 256,
  STANDARD: 500,
  DEEP: 1_000,
} as const
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_WALL_TIME_MS = 60_000
export const MAX_WALK_ENTRIES = 50_000
export const MAX_WALK_DEPTH = 40
const MAX_REPRESENTATIVE_SKIPPED_PATHS = 20

const HIGH_PRIORITY_FILES = new Set([
  "bun.lock",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "next.config.js",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.json",
  "tsconfig.json",
  "vercel.json",
  "yarn.lock",
])

const LOW_PRIORITY_SEGMENTS = new Set([
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "__tests__",
  "examples",
  "fixtures",
  "mocks",
  "samples",
  "spec",
  "specs",
  "test",
  "tests",
])

export function resolveAiAppSecurityDiscoveryMode(
  mode?: string
): AiAppSecurityDiscoveryReceipt["mode"] {
  switch (mode?.trim().toUpperCase()) {
    case "STANDARD":
      return "STANDARD"
    case "DEEP":
    case "CUSTOM":
      return "DEEP"
    default:
      return "QUICK"
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sourcePriority(filePath: string): number {
  const normalized = filePath.split(sep).join("/").toLowerCase()
  const segments = normalized.split("/")
  const fileName = segments.at(-1) ?? normalized
  if (HIGH_PRIORITY_FILES.has(fileName) || segments[0] === ".github" || segments[0] === ".agents") {
    return 0
  }
  if (
    segments.some((segment) => LOW_PRIORITY_SEGMENTS.has(segment)) ||
    /(?:^|[._-])(fixture|mock|sample|spec|test)s?(?:[._-]|$)/.test(fileName)
  ) {
    return 2
  }
  return 1
}

function toLanguage(extension: string): AIScanFile["language"] {
  switch (extension) {
    case ".js":
      return "javascript"
    case ".jsx":
      return "jsx"
    case ".ts":
      return "typescript"
    case ".tsx":
      return "tsx"
    case ".mjs":
    case ".cjs":
      return "javascript"
    case ".astro":
    case ".html":
    case ".htm":
      return "unknown"
    case ".py":
      return "python"
    case ".json":
      return "json"
    case ".toml":
      return "toml"
    case ".yaml":
    case ".yml":
      return "yaml"
    default:
      return "unknown"
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("AI App Security scan cancelled")
}

export async function collectSourceFiles(
  repoPath: string,
  coverageIssues: ScannerCoverageIssue[],
  mode: AiAppSecurityDiscoveryReceipt["mode"],
  signal?: AbortSignal
): Promise<{ files: AIScanFile[]; discovery: AiAppSecurityDiscoveryReceipt }> {
  type Candidate = { fullPath: string; path: string; size: number }
  const candidates: Candidate[] = []
  const selected: AIScanFile[] = []
  const skippedPaths: string[] = []
  const skippedByReason = { fileLimit: 0, totalByteLimit: 0, oversized: 0, unreadable: 0 }
  const limitsReached = new Set<AIScanLimit>()
  const maxFiles = MAX_FILES_BY_MODE[mode]
  let totalBytes = 0
  let statUnreadable = 0

  async function walk(directory: string, depth: number, state: { entries: number }): Promise<void> {
    throwIfAborted(signal)
    if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "bounded",
        reason: "AI App Security source discovery reached its bounded repository walk limit",
      })
      return
    }

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
    } catch {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "partial",
        subject: relative(repoPath, directory) || ".",
        reason: "AI App Security scan could not read source directory",
      })
      return
    }

    entries.sort((left, right) => comparePaths(left.name, right.name))
    for (const entry of entries) {
      throwIfAborted(signal)
      if (++state.entries > MAX_WALK_ENTRIES) {
        recordCoverageIssue(coverageIssues, {
          scanner: "ai_app_security",
          status: "bounded",
          reason: "AI App Security source discovery reached its bounded repository walk limit",
        })
        break
      }
      if (entry.isSymbolicLink()) continue
      const fullPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(fullPath, depth + 1, state)
        }
        continue
      }

      if (!entry.isFile()) continue
      const extension = fullPath.slice(fullPath.lastIndexOf("."))
      if (!SUPPORTED_EXTENSIONS.has(extension) && !WEBMCP_CONFIG_FILES.has(entry.name)) continue
      try {
        const stats = await lstat(fullPath)
        if (!stats.isFile()) continue
        candidates.push({ fullPath, path: relative(repoPath, fullPath), size: stats.size })
      } catch {
        statUnreadable++
        skippedByReason.unreadable++
        skippedPaths.push(relative(repoPath, fullPath))
        recordCoverageIssue(coverageIssues, {
          scanner: "ai_app_security",
          status: "partial",
          subject: relative(repoPath, fullPath),
          reason: "AI App Security scan could not read source file",
        })
      }
    }
  }

  await walk(repoPath, 0, { entries: 0 })
  candidates.sort(
    (left, right) =>
      sourcePriority(left.path) - sourcePriority(right.path) || comparePaths(left.path, right.path)
  )

  for (const candidate of candidates) {
    throwIfAborted(signal)
    if (candidate.size > MAX_FILE_BYTES) {
      skippedByReason.oversized++
      skippedPaths.push(candidate.path)
      limitsReached.add("max_file_bytes")
      continue
    }
    if (selected.length >= maxFiles) {
      skippedByReason.fileLimit++
      skippedPaths.push(candidate.path)
      limitsReached.add("max_files")
      continue
    }
    if (totalBytes + candidate.size > MAX_TOTAL_BYTES) {
      skippedByReason.totalByteLimit++
      skippedPaths.push(candidate.path)
      limitsReached.add("max_total_bytes")
      continue
    }

    try {
      const content = await readFile(candidate.fullPath, "utf8")
      selected.push({
        path: candidate.path,
        content,
        size: candidate.size,
        extension: candidate.fullPath.slice(candidate.fullPath.lastIndexOf(".")),
        language: toLanguage(candidate.fullPath.slice(candidate.fullPath.lastIndexOf("."))),
      })
      totalBytes += candidate.size
    } catch {
      skippedByReason.unreadable++
      skippedPaths.push(candidate.path)
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "partial",
        subject: candidate.path,
        reason: "AI App Security scan could not read source file",
      })
    }
  }

  const discovery: AiAppSecurityDiscoveryReceipt = {
    version: "ai-app-security-discovery/1",
    mode,
    maxFiles,
    eligibleFiles: candidates.length + statUnreadable,
    scannedFiles: selected.length,
    skippedFiles: skippedPaths.length,
    scannedBytes: totalBytes,
    representativeSkippedPaths: skippedPaths.slice(0, MAX_REPRESENTATIVE_SKIPPED_PATHS),
    skippedByReason,
    limitsReached: [...limitsReached],
  }

  if (skippedByReason.fileLimit > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "bounded",
      reason: `AI App Security scanned ${selected.length} of ${discovery.eligibleFiles} eligible files; ${skippedByReason.fileLimit} exceeded the ${mode} file limit (${maxFiles})`,
      metadata: { ...discovery },
    })
  }
  if (skippedByReason.oversized > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "bounded",
      reason: `AI App Security skipped ${skippedByReason.oversized} file(s) exceeding ${MAX_FILE_BYTES} bytes`,
      metadata: { ...discovery },
    })
  }
  if (skippedByReason.totalByteLimit > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "bounded",
      reason: `AI App Security skipped ${skippedByReason.totalByteLimit} file(s) after reaching the ${MAX_TOTAL_BYTES}-byte scan limit`,
      metadata: { ...discovery },
    })
  }

  return { files: selected, discovery }
}
