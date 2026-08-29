/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { join, relative, sep } from "path"
import { logger } from "@lyrashield/logger"
import {
  AI_SECURITY_CONTROLS,
  AI_SECURITY_CONTROLS_BY_ID,
  AI_SECURITY_DETECTOR_VERSION,
  buildSignal,
  scanAiSecurityFiles,
  summarizeAiSecurityCoverage,
  type AIScanFile,
  type AIScanLimit,
  type AIScanResult,
  type AISecuritySignalState,
} from "@lyrashield/security/ai-security"
import { scanAiDataExposure, type AiDataExposureFinding } from "@lyrashield/security"
import { discoverWebMcpTools } from "@lyrashield/security/webmcp/discover"
import { evaluateWebMcpSurface } from "@lyrashield/security/webmcp"
import {
  WEBMCP_CONTROLS_BY_ID,
  type WebMcpBehavior,
  type WebMcpCoverageReceipt as SecurityWebMcpCoverageReceipt,
  type WebMcpDefinitionKind,
  type WebMcpSignal,
} from "@lyrashield/security/webmcp"
import {
  queryOsvWithCache,
  type AdvisoryBatchResult,
  type OsvQueryPackage,
  type OsvQueryResult,
} from "@lyrashield/db"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import { resolveExactDependencies, type ResolvedDependencyInventory } from "./resolved-dependencies"

export interface AiAppSecurityScanConfig {
  repoPath: string
  workspaceDir: string
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
  dependencyInventory?: ResolvedDependencyInventory
  advisoryBatch?: AdvisoryBatchResult
  mode?: string
}

export interface WebMcpCoverageReceipt extends SecurityWebMcpCoverageReceipt {
  toolCounts: {
    byKind: Record<WebMcpDefinitionKind, number>
    byBehavior: Record<WebMcpBehavior, number>
  }
  exposurePosture: {
    dynamic: number
    wildcard: number
    explicitSelf: number
    explicitTrusted: number
    missingOrUnknown: number
  }
  confirmationPosture: {
    mutationTools: number
    unconfirmedMutations: number
  }
  methodology: string[]
}

export interface AiAppSecurityScanResult {
  findings: EngineVulnerability[]
  aiScanResult: AIScanResult
  ai03AdvisoryFresh: boolean
  ai03Coverage: Ai03CoverageReceipt
  discovery: AiAppSecurityDiscoveryReceipt
  webMcpFindings: EngineVulnerability[]
  webMcpCoverage: WebMcpCoverageReceipt | null
}

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

export interface Ai03CoverageReceipt {
  state: AISecuritySignalState
  advisoryStatus: AdvisoryBatchResult["status"]
  resolutionStatus: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
  fresh: boolean
  source: "OSV"
  snapshotId: string | null
  snapshotChecksum: string | null
  fetchedAt: string | null
  requestedPackages: number
  resolvedPackages: number
  unresolvedReasons: string[]
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

const IGNORED_DIRECTORIES = new Set([
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
  QUICK: 200,
  STANDARD: 500,
  DEEP: 1_000,
} as const
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_WALL_TIME_MS = 60_000
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("AI App Security scan cancelled")
}

async function collectSourceFiles(
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

type DependencyResolution = {
  packages: OsvQueryPackage[]
  status: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
  unresolvedReasons: string[]
  evidenceFile: AIScanFile
}

function toDependencyResolution(inventory: ResolvedDependencyInventory): DependencyResolution {
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

async function collectDependencyPackages(
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

function toAdvisoryVulnerabilities(result: OsvQueryResult): EngineVulnerability[] {
  const control = AI_SECURITY_CONTROLS_BY_ID["AI-03"]
  const packageRef = `${result.package.name}@${result.package.version}`
  return result.vulns.map((vuln) => {
    const fixedVersion = (
      vuln.affected?.flatMap(
        (affected) => affected.ranges?.flatMap((range) => range.events) ?? []
      ) ?? []
    )
      .filter((event): event is { fixed: string } => event.fixed !== undefined)
      .map((event) => event.fixed)
      .sort()[0]
    return {
      id: vuln.id,
      title: control?.title ?? `AI-03: Dependency advisory in ${packageRef}`,
      severity: "HIGH",
      timestamp: new Date().toISOString(),
      target: packageRef,
      finding_class: "dependency_advisory",
      dependency_metadata: {
        package_name: result.package.name,
        installed_version: result.package.version,
        package_ecosystem: result.package.ecosystem.toLowerCase(),
      },
      description: control?.description,
      evidence: `dependency lockfile: ${result.package.filePath} — ${packageRef}`,
      technical_analysis: `${packageRef} is affected by ${vuln.id}. ${vuln.summary ?? ""}`,
      remediation_steps: fixedVersion
        ? `Upgrade ${result.package.name} to ${fixedVersion} or later. Update the dependency in ${result.package.filePath}.`
        : `Review ${vuln.id} for ${packageRef} and consider replacing the dependency or applying a workaround.`,
      scannerSource: "ai_app_security" as const,
    }
  })
}

function toEngineVulnerability(
  signal: import("@lyrashield/security/ai-security").AISecuritySignal
): EngineVulnerability {
  const control = AI_SECURITY_CONTROLS_BY_ID[signal.controlId]
  const remediation =
    signal.remediation ?? control?.remediationTemplate ?? "Review the finding and remediate."
  const evidence = signal.snippet
    ? `${signal.file}:${signal.line}: ${signal.snippet}`
    : signal.evidenceSource

  return {
    id: signal.controlId,
    title: `${signal.controlId}: ${control?.title ?? signal.state}`,
    severity: signal.severity,
    timestamp: new Date().toISOString(),
    description: control?.description,
    evidence,
    technical_analysis: `${signal.controlId} (${signal.ruleId}) is ${signal.state} in ${signal.file}${signal.line ? ` at line ${signal.line}` : ""}. ${remediation}`,
    remediation_steps: remediation,
    scannerSource: "ai_app_security" as const,
  }
}

function toAiDataExposureVulnerability(
  finding: AiDataExposureFinding,
  file: string
): EngineVulnerability {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    timestamp: new Date().toISOString(),
    target: file,
    cwe: finding.cwe,
    description: finding.description,
    remediation_steps: finding.remediation,
    control_ids: finding.controlIds,
    code_locations: [
      {
        file,
        start_line: finding.line,
        end_line: finding.line,
        snippet: finding.snippet,
      },
    ],
    scannerSource: "ai_app_security" as const,
  }
}

function toWebMcpEngineVulnerability(signal: WebMcpSignal): EngineVulnerability {
  const control = WEBMCP_CONTROLS_BY_ID[signal.controlId]
  const remediation =
    signal.remediation ??
    control?.remediationTemplate ??
    "Review the WebMCP tool surface and remediate."
  const evidence = signal.snippet
    ? `${signal.file}:${signal.line}: ${signal.snippet}`
    : `${signal.file}${signal.line ? `:${signal.line}` : ""}`

  return {
    id: signal.controlId,
    title: control?.title ?? `${signal.controlId}: ${signal.state}`,
    severity: signal.severity,
    timestamp: new Date().toISOString(),
    target: signal.file,
    cwe: "CWE-749",
    finding_class: "webmcp_tool_surface",
    description: control?.description,
    evidence,
    technical_analysis: `${signal.controlId} (${signal.ruleId}) is ${signal.state} in ${signal.file}${signal.line ? ` at line ${signal.line}` : ""}. ${remediation}`,
    remediation_steps: remediation,
    code_locations:
      signal.file && signal.line
        ? [
            {
              file: signal.file,
              start_line: signal.line,
              end_line: signal.endLine ?? signal.line,
              snippet: signal.snippet,
            },
          ]
        : undefined,
    scannerSource: "ai_app_security" as const,
  }
}

function buildWebMcpCoverageReceipt(
  files: AIScanFile[],
  inventory: import("@lyrashield/security/webmcp").WebMcpToolInventory,
  signals: WebMcpSignal[],
  discovery: AiAppSecurityDiscoveryReceipt
): WebMcpCoverageReceipt {
  const definitions = inventory.definitions
  const kindCounts: Record<WebMcpDefinitionKind, number> = {
    imperative: definitions.filter((d) => d.kind === "imperative").length,
    declarative: definitions.filter((d) => d.kind === "declarative").length,
  }
  const behaviorCounts: Record<WebMcpBehavior, number> = {
    read: 0,
    "ui-only": 0,
    mutation: 0,
    unknown: 0,
  }
  for (const d of definitions) {
    behaviorCounts[d.behavior]++
  }

  const posture = {
    dynamic: 0,
    wildcard: 0,
    explicitSelf: 0,
    explicitTrusted: 0,
    missingOrUnknown: 0,
  }
  for (const d of definitions) {
    if (d.exposedTo === "dynamic") {
      posture.dynamic++
    } else if (Array.isArray(d.exposedTo)) {
      const hasWildcard = d.exposedTo.some((o) => o === "*" || o.includes("*"))
      const hasSelf = d.exposedTo.some((o) => o.includes("self"))
      if (hasWildcard) {
        posture.wildcard++
      } else if (hasSelf) {
        posture.explicitSelf++
      } else if (d.exposedTo.length > 0) {
        posture.explicitTrusted++
      } else {
        posture.missingOrUnknown++
      }
    } else {
      posture.missingOrUnknown++
    }
  }

  const confirmation = {
    mutationTools: definitions.filter((d) => d.behavior === "mutation").length,
    unconfirmedMutations: signals.filter(
      (s) => s.controlId === "WEBMCP-05" && s.state === "DETECTED"
    ).length,
  }

  const structurallyIncomplete = definitions.filter(
    (d) =>
      d.name === null ||
      d.behavior === "unknown" ||
      d.inputSchema.type === "unknown" ||
      d.inputSchema.type === "any"
  ).length
  const incompleteDefinitions = Math.max(inventory.incompleteDefinitions, structurallyIncomplete)

  const eligibleFiles = Math.max(0, files.length - inventory.unsupportedFiles.length)
  const scannedFiles = Math.max(0, eligibleFiles - inventory.truncatedFiles.length)
  const unscannedPaths = new Set([...inventory.unsupportedFiles, ...inventory.truncatedFiles])
  const limitsReached = [...new Set([...discovery.limitsReached, ...inventory.limitsReached])]
  const coverageState =
    discovery.skippedFiles === 0 &&
    incompleteDefinitions === 0 &&
    inventory.truncatedFiles.length === 0 &&
    limitsReached.length === 0
      ? "COMPLETE"
      : "INCONCLUSIVE"

  return {
    version: "webmcp-assurance/1",
    detectorVersion: inventory.detectorVersion,
    coverageState,
    eligibleFiles,
    scannedFiles,
    scannedBytes: files.reduce(
      (total, file) => total + (unscannedPaths.has(file.path) ? 0 : file.size),
      0
    ),
    toolDefinitionsFound: definitions.length,
    toolDefinitionsAssessed: Math.max(0, definitions.length - structurallyIncomplete),
    incompleteDefinitions,
    imperativeDefinitions: kindCounts.imperative,
    declarativeDefinitions: kindCounts.declarative,
    limitsReached,
    inventoryChecksum: inventory.checksum,
    sourceSelection: {
      eligibleFiles: discovery.eligibleFiles,
      selectedFiles: discovery.scannedFiles,
      skippedFiles: discovery.skippedFiles,
      scannedBytes: discovery.scannedBytes,
      skippedByReason: { ...discovery.skippedByReason },
      limits: {
        maxFiles: discovery.maxFiles,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxWalkEntries: MAX_WALK_ENTRIES,
        maxWalkDepth: MAX_WALK_DEPTH,
      },
      limitsReached: [...discovery.limitsReached],
    },
    toolCounts: {
      byKind: kindCounts,
      byBehavior: behaviorCounts,
    },
    exposurePosture: posture,
    confirmationPosture: confirmation,
    methodology: [
      "WebMCP discovery runs over the same source files as AI App Security.",
      "The receipt contains bounded metadata only: no raw source, schemas, or workspace identifiers.",
      `WebMCP received ${discovery.scannedFiles} of ${discovery.eligibleFiles} repository-eligible files from outer source selection.`,
      `${eligibleFiles} selected file(s) were eligible for WebMCP analysis; unsupported source languages were excluded from the WebMCP scope.`,
      coverageState === "INCONCLUSIVE"
        ? "Coverage is INCONCLUSIVE because source selection or WebMCP discovery was incomplete."
        : "Outer source selection and WebMCP discovery completed without recorded limits.",
      incompleteDefinitions > 0
        ? `${incompleteDefinitions} tool definition(s) were incomplete and could not be fully assessed.`
        : "All discovered tool definitions had enough static structure to be assessed.",
    ],
  }
}

async function runWebMcpScan(
  files: AIScanFile[],
  discovery: AiAppSecurityDiscoveryReceipt,
  coverageIssues: ScannerCoverageIssue[],
  signal?: AbortSignal
): Promise<{ findings: EngineVulnerability[]; coverage: WebMcpCoverageReceipt | null }> {
  const scanFiles: import("@lyrashield/security/webmcp").WebMcpScanFile[] = files.map((file) => ({
    ...file,
    truncated: false,
  }))

  try {
    const { inventory, context } = await discoverWebMcpTools(scanFiles, {
      limits: {
        maxFiles: 1_000,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxWallTimeMs: MAX_WALL_TIME_MS,
        maxDefinitions: 500,
      },
      signal,
    })

    const signals = evaluateWebMcpSurface(scanFiles, inventory, context)
    const webMcpFindings: EngineVulnerability[] = []
    for (const signal of signals) {
      if (signal.state === "DETECTED") {
        webMcpFindings.push(toWebMcpEngineVulnerability(signal))
      }
    }

    if (inventory.limitsReached.length > 0) {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "bounded",
        reason: `WebMCP discovery reached its limit: ${inventory.limitsReached.join(", ")}`,
        metadata: { webMcpLimits: inventory.limitsReached },
      })
    }

    if (inventory.incompleteDefinitions > 0 || inventory.truncatedFiles.length > 0) {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "partial",
        reason: "WebMCP discovery could not fully assess every eligible definition",
        metadata: {
          incompleteDefinitions: inventory.incompleteDefinitions,
          truncatedFiles: inventory.truncatedFiles.length,
        },
      })
    }

    const coverage = buildWebMcpCoverageReceipt(files, inventory, signals, discovery)
    return { findings: webMcpFindings, coverage }
  } catch (err) {
    logger.warn("WebMCP scan failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "partial",
      reason: "WebMCP discovery or evaluation failed",
      metadata: { error: err instanceof Error ? err.message : String(err) },
    })
    return { findings: [], coverage: null }
  }
}

export async function scanAiAppSecurity({
  repoPath,
  coverageIssues = [],
  signal,
  dependencyInventory,
  advisoryBatch: injectedAdvisoryBatch,
  mode: requestedMode,
}: AiAppSecurityScanConfig): Promise<AiAppSecurityScanResult> {
  logger.info("Starting AI App Security scan phase")
  throwIfAborted(signal)

  const mode = resolveAiAppSecurityDiscoveryMode(requestedMode)
  const { files, discovery } = await collectSourceFiles(repoPath, coverageIssues, mode, signal)
  if (files.length === 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "unsupported",
      reason: "No supported source files found for AI App Security scan",
    })
    const notAssessedControls = {} as AIScanResult["coverage"]["controls"]
    for (const control of AI_SECURITY_CONTROLS) {
      notAssessedControls[control.id] = {
        controlId: control.id,
        state: "NOT_ASSESSED",
        assessed: false,
        ruleIds: [],
        fileCount: 0,
        signalCount: 0,
      }
    }

    return {
      findings: [],
      aiScanResult: {
        signals: [],
        coverage: {
          version: AI_SECURITY_DETECTOR_VERSION,
          totalControls: AI_SECURITY_CONTROLS.length,
          assessedCount: 0,
          notAssessedCount: AI_SECURITY_CONTROLS.length,
          detectedCount: 0,
          noFindingCount: 0,
          inconclusiveCount: 0,
          controls: notAssessedControls,
          limitsReached: discovery.limitsReached,
          unsupportedFiles: [],
          truncatedFiles: [],
        },
        provenance: {
          files: 0,
          bytes: 0,
          scannedAt: new Date().toISOString(),
          limitsReached: discovery.limitsReached,
          detectorVersion: AI_SECURITY_DETECTOR_VERSION,
        },
      },
      ai03AdvisoryFresh: false,
      ai03Coverage: {
        state: "NOT_ASSESSED",
        advisoryStatus: "UNAVAILABLE",
        resolutionStatus: "UNSUPPORTED",
        fresh: false,
        source: "OSV",
        snapshotId: null,
        snapshotChecksum: null,
        fetchedAt: null,
        requestedPackages: 0,
        resolvedPackages: 0,
        unresolvedReasons: ["No supported source files found"],
      },
      discovery,
      webMcpFindings: [],
      webMcpCoverage: null,
    }
  }

  const result = scanAiSecurityFiles(files, {
    limits: {
      maxFiles: discovery.maxFiles,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxWallTimeMs: MAX_WALL_TIME_MS,
    },
  })
  result.coverage.limitsReached = [
    ...new Set([...result.coverage.limitsReached, ...discovery.limitsReached]),
  ]
  result.provenance.limitsReached = [
    ...new Set([...result.provenance.limitsReached, ...discovery.limitsReached]),
  ]

  const findings: EngineVulnerability[] = []
  for (const signal of result.signals) {
    if (signal.state === "DETECTED") {
      findings.push(toEngineVulnerability(signal))
    }
  }
  for (const file of files) {
    for (const exposure of scanAiDataExposure(file)) {
      findings.push(toAiDataExposureVulnerability(exposure, file.path))
    }
  }

  const { findings: webMcpFindings, coverage: webMcpCoverage } = await runWebMcpScan(
    files,
    discovery,
    coverageIssues,
    signal
  )
  findings.push(...webMcpFindings)

  throwIfAborted(signal)
  let dependencyResolution: DependencyResolution
  try {
    dependencyResolution = dependencyInventory
      ? toDependencyResolution(dependencyInventory)
      : toDependencyResolution(await resolveExactDependencies({ repoPath, coverageIssues, signal }))
  } catch (error) {
    logger.warn("Exact AI-03 dependency resolution failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    // The legacy parser is retained only to identify potentially affected
    // packages for an inconclusive result. A resolver failure must never turn
    // into a clean AI-03 outcome, even when the fallback sees exact versions.
    const fallback = await collectDependencyPackages(repoPath, coverageIssues, signal)
    dependencyResolution = {
      ...fallback,
      status: "PARTIAL",
      unresolvedReasons: [
        ...fallback.unresolvedReasons,
        "Exact dependency resolver failed; advisory coverage is inconclusive",
      ],
    }
  }
  let advisoryBatch: AdvisoryBatchResult = {
    status: "UNAVAILABLE",
    source: "OSV",
    requestedCount: 0,
    resolvedCount: 0,
    results: [],
    fetchedAt: null,
    snapshotId: null,
    snapshotChecksum: null,
    cacheAgeSeconds: null,
    supportedEcosystems: [],
    unresolved: [],
  }
  if (injectedAdvisoryBatch) {
    advisoryBatch = injectedAdvisoryBatch
  } else if (dependencyResolution.packages.length > 0) {
    logger.info("AI App Security dependency advisory scan starting", {
      packageCount: dependencyResolution.packages.length,
    })
    try {
      advisoryBatch = await queryOsvWithCache(dependencyResolution.packages)

      for (const advisory of advisoryBatch.results) {
        if (advisory.vulns.length > 0) {
          findings.push(...toAdvisoryVulnerabilities(advisory))
          result.signals.push(
            buildSignal(
              "AI-03",
              "AI-03.osv-advisory",
              "DETECTED",
              dependencyResolution.evidenceFile,
              {
                evidenceSource: "advisory",
                overrideSeverity: "MEDIUM",
                overrideRemediation: `Upgrade ${advisory.package.name} to a patched version or replace the dependency.`,
              }
            )
          )
        }
      }
    } catch (err) {
      logger.warn("AI App Security dependency advisory scan failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "partial",
        reason: "AI-03 dependency advisory query failed",
      })
    }
  }

  const ai03Complete =
    dependencyResolution.status === "COMPLETE" && advisoryBatch.status === "COMPLETE"
  const ai03Coverage: Ai03CoverageReceipt = {
    state: advisoryBatch.results.some((entry) => entry.vulns.length > 0)
      ? "DETECTED"
      : ai03Complete
        ? "NO_FINDING"
        : "INCONCLUSIVE",
    advisoryStatus: advisoryBatch.status,
    resolutionStatus: dependencyResolution.status,
    fresh: ai03Complete,
    source: "OSV",
    snapshotId: advisoryBatch.snapshotId,
    snapshotChecksum: advisoryBatch.snapshotChecksum,
    fetchedAt: advisoryBatch.fetchedAt,
    requestedPackages: dependencyResolution.packages.length,
    resolvedPackages: advisoryBatch.resolvedCount,
    unresolvedReasons: [
      ...dependencyResolution.unresolvedReasons,
      ...advisoryBatch.unresolved.map(
        (entry) => `${entry.ecosystem}:${entry.name}: ${entry.reason}`
      ),
    ],
  }
  if (ai03Coverage.state !== "NO_FINDING" && ai03Coverage.state !== "DETECTED") {
    result.signals.push(
      buildSignal(
        "AI-03",
        "AI-03.osv-coverage",
        ai03Coverage.state,
        dependencyResolution.evidenceFile,
        {
          evidenceSource: "advisory",
          overrideRemediation:
            ai03Coverage.unresolvedReasons.join("; ") || "AI-03 could not be assessed",
        }
      )
    )
  }

  result.coverage = {
    ...result.coverage,
    ...summarizeAiSecurityCoverage(
      result.signals,
      AI_SECURITY_CONTROLS.map((c) => c.id),
      {
        limitsReached: result.coverage.limitsReached,
        unsupportedFiles: result.coverage.unsupportedFiles,
        truncatedFiles: result.coverage.truncatedFiles,
      }
    ),
  }

  const detectedCount = result.signals.filter((s) => s.state === "DETECTED").length
  logger.info("AI App Security scan phase complete", {
    fileCount: files.length,
    signalCount: result.signals.length,
    detectedCount,
    advisoryFindings: findings.length - detectedCount,
  })

  return {
    findings,
    aiScanResult: result,
    ai03AdvisoryFresh: ai03Coverage.fresh,
    ai03Coverage,
    discovery,
    webMcpFindings,
    webMcpCoverage,
  }
}
