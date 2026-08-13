/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { join, relative } from "path"
import { logger } from "@lyrashield/logger"
import {
  AI_SECURITY_CONTROLS,
  AI_SECURITY_CONTROLS_BY_ID,
  AI_SECURITY_DETECTOR_VERSION,
  buildSignal,
  scanAiSecurityFiles,
  summarizeAiSecurityCoverage,
  type AIScanFile,
  type AIScanResult,
  type AISecuritySignalState,
} from "@lyrashield/security/ai-security"
import { scanAiDataExposure, type AiDataExposureFinding } from "@lyrashield/security"
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
}

export interface AiAppSecurityScanResult {
  findings: EngineVulnerability[]
  aiScanResult: AIScanResult
  ai03AdvisoryFresh: boolean
  ai03Coverage: Ai03CoverageReceipt
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
  ".py",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
])

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".astro",
])

const MAX_FILES = 200
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_WALL_TIME_MS = 60_000
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40

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
  signal?: AbortSignal
): Promise<AIScanFile[]> {
  const selected: AIScanFile[] = []
  let totalBytes = 0

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
      const extension = fullPath.slice(fullPath.lastIndexOf("."))
      if (!SUPPORTED_EXTENSIONS.has(extension)) continue
      if (selected.length >= MAX_FILES) {
        recordCoverageIssue(coverageIssues, {
          scanner: "ai_app_security",
          status: "bounded",
          reason: `AI App Security scan file count limit reached (${MAX_FILES})`,
        })
        return
      }

      try {
        const stats = await lstat(fullPath)
        if (!stats.isFile()) continue
        if (stats.size > MAX_FILE_BYTES) {
          recordCoverageIssue(coverageIssues, {
            scanner: "ai_app_security",
            status: "bounded",
            subject: relative(repoPath, fullPath),
            reason: `AI App Security scan skipped file exceeding ${MAX_FILE_BYTES} bytes`,
          })
          continue
        }
        if (totalBytes + stats.size > MAX_TOTAL_BYTES) {
          recordCoverageIssue(coverageIssues, {
            scanner: "ai_app_security",
            status: "bounded",
            reason: `AI App Security scan total size limit reached (${MAX_TOTAL_BYTES} bytes)`,
          })
          return
        }

        const content = await readFile(fullPath, "utf8")
        const file: AIScanFile = {
          path: relative(repoPath, fullPath),
          content,
          size: content.length,
          extension,
          language: toLanguage(extension),
        }
        selected.push(file)
        totalBytes += file.size
      } catch {
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
  return selected
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
    title: control?.title ?? `${signal.controlId}: ${signal.state}`,
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

export async function scanAiAppSecurity({
  repoPath,
  coverageIssues = [],
  signal,
  dependencyInventory,
  advisoryBatch: injectedAdvisoryBatch,
}: AiAppSecurityScanConfig): Promise<AiAppSecurityScanResult> {
  logger.info("Starting AI App Security scan phase")
  throwIfAborted(signal)

  const files = await collectSourceFiles(repoPath, coverageIssues, signal)
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
          limitsReached: ["max_files"],
          unsupportedFiles: [],
          truncatedFiles: [],
        },
        provenance: {
          files: 0,
          bytes: 0,
          scannedAt: new Date().toISOString(),
          limitsReached: ["max_files"],
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
    }
  }

  const result = scanAiSecurityFiles(files, {
    limits: {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxWallTimeMs: MAX_WALL_TIME_MS,
    },
  })

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

  return { findings, aiScanResult: result, ai03AdvisoryFresh: ai03Coverage.fresh, ai03Coverage }
}
