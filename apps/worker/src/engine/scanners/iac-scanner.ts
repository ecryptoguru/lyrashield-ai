// security-scan-skip-file: detection rules reference dangerous patterns by design
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { basename, join, relative } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"
import { dockerContext, composeEnvironmentLines, terraformIngressLines } from "./iac-context"
import { IAC_RULES, K8S_MISSING_SECURITY_CONTEXT, type IacFileKind } from "./iac-rules"
import { isPhpRuntimeInput } from "./php-runtime"
import { createPhpRuntimeDiscovery } from "./php-runtime-discovery"
import { isExcludedPhpPath, isPhpServiceBoundary } from "./php-project"
import {
  recordCoverageIssue,
  type ScannerCoverageIssue,
  type ScannerDiscovery,
} from "../scanner-coverage"

interface IacScanConfig {
  repoPath: string
  workspaceDir: string
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
  discovery?: ScannerDiscovery
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("IaC scan cancelled")
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "vendor",
  ".terraform",
  "__pycache__",
  ".turbo",
  "venv",
  ".venv",
  "target",
])

const MAX_FILE_SIZE = 512 * 1024
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_FINDINGS_PER_FILE = 100
const MAX_TOTAL_FINDINGS = 5_000

const K8S_API_VERSION = /^apiVersion:\s*\S+/m
const K8S_KIND =
  /^kind:\s*(Deployment|Pod|DaemonSet|StatefulSet|Job|CronJob|Service|Role|ClusterRole|RoleBinding|ClusterRoleBinding|NetworkPolicy|Ingress|Secret|ConfigMap|ServiceAccount)\b/m

function classify(path: string, content: string): IacFileKind | null {
  const name = basename(path)
  if (/^Dockerfile(?:\..+)?$/i.test(name) || name.toLowerCase() === "containerfile") {
    return "dockerfile"
  }
  if (/\.tf$/i.test(name)) return "terraform"
  if (/^docker-compose.*\.ya?ml$/i.test(name) || /^compose\.ya?ml$/i.test(name)) {
    return "compose"
  }
  if (/\.ya?ml$/i.test(name) && K8S_API_VERSION.test(content) && K8S_KIND.test(content)) {
    return "kubernetes"
  }
  return null
}

function isIacCandidateName(name: string): boolean {
  return (
    /^Dockerfile(?:\..+)?$/i.test(name) ||
    name.toLowerCase() === "containerfile" ||
    /\.tf$/i.test(name) ||
    /\.ya?ml$/i.test(name) ||
    isPhpRuntimeInput(name)
  )
}

async function walkDir(
  dir: string,
  files: string[],
  state = {
    entries: 0,
    bounded: false,
    oversizedFiles: 0,
    unreadable: 0,
    phpSources: 0,
    symlinks: 0,
    phpDirectories: new Set<string>(),
    serviceDirectories: new Set<string>(),
  },
  depth = 0,
  signal?: AbortSignal,
  root = dir
): Promise<void> {
  throwIfAborted(signal)
  if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
    state.bounded = true
    return
  }
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    state.unreadable++
    return
  }

  for (const entry of entries) {
    throwIfAborted(signal)
    if (++state.entries > MAX_WALK_ENTRIES) {
      state.bounded = true
      break
    }
    const fullPath = join(dir, entry)
    let s
    try {
      s = await lstat(fullPath)
    } catch {
      state.unreadable++
      continue
    }
    if (s.isSymbolicLink()) {
      if (isIacCandidateName(entry) || /\.php$/i.test(entry)) state.symlinks++
      continue
    }
    if (s.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) {
        await walkDir(fullPath, files, state, depth + 1, signal, root)
      }
    } else if (s.isFile()) {
      if (isPhpServiceBoundary(entry) && !isExcludedPhpPath(relative(root, fullPath)))
        state.serviceDirectories.add(dir)
      if (/\.php$/i.test(entry) && !isExcludedPhpPath(relative(root, fullPath))) {
        state.phpSources++
        state.phpDirectories.add(dir)
      }
      if (!isIacCandidateName(entry)) continue
      if (s.size <= MAX_FILE_SIZE) {
        files.push(fullPath)
      } else {
        state.oversizedFiles++
      }
    }
  }
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  )
}

/** Track containing variable blocks without treating quoted braces as HCL structure. */
// ponytail: lexical block scope; use an HCL parser if expression or heredoc defaults are added.
function terraformVariableContexts(content: string): Array<string | null> {
  let variableName: string | null = null
  let depth = 0
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const code = line.replace(/"(?:\\.|[^"\\])*"|#[^\n]*|\/\/[^\n]*/g, (token) =>
        token.startsWith('"') ? token : ""
      )
      const declaration = /^\s*variable\s+"([^"\n]+)"\s*\{/.exec(code)
      if (depth === 0 && declaration) variableName = declaration[1] ?? null
      const current = variableName
      const structure = code.replace(/"(?:\\.|[^"\\])*"/g, "")
      depth += (structure.match(/\{/g)?.length ?? 0) - (structure.match(/\}/g)?.length ?? 0)
      if (depth <= 0) {
        depth = 0
        variableName = null
      }
      return current
    })
}

function inspectIacContent(
  content: string,
  kind: IacFileKind | null,
  relPath: string,
  findings: EngineVulnerability[],
  seenFindings: Set<string>,
  signal: AbortSignal | undefined,
  initialFindingsInFile: number
): boolean {
  const lines = content.split("\n")
  const docker = kind === "dockerfile" ? dockerContext(lines) : undefined
  const environment = kind === "compose" ? composeEnvironmentLines(lines) : undefined
  const ingress = kind === "terraform" ? terraformIngressLines(content) : undefined
  let findingsInFile = initialFindingsInFile
  let findingLimitReached = false
  // Absence rules inspect the final stage's declared user and workload
  // privilege boundaries. An external base image's user requires independent review.
  if (docker?.implicitRoot && docker.rootLine === undefined) {
    const rule = IAC_RULES.find((r) => r.id === "iac-dockerfile-user-root")
    if (rule && findingsInFile < MAX_FINDINGS_PER_FILE) {
      findingsInFile++
      findings.push({
        id: `${rule.id}-${relPath}-absent`,
        title: `${rule.name} in ${relPath}`,
        severity: rule.severity,
        timestamp: new Date().toISOString(),
        target: relPath,
        cwe: rule.cwe,
        description: rule.description,
        technical_analysis: `${rule.name} — ${relPath} has no effective non-root USER in the final stage; review the inherited base-image user.`,
        impact: rule.impact,
        remediation_steps: rule.remediation,
        poc_description: `Inspect ${relPath}: no effective non-root USER is declared in the final stage.`,
        ...(rule.controlIds ? { control_ids: rule.controlIds } : {}),
        code_locations: [{ file: relPath, start_line: 1, label: rule.name }],
      })
    }
  }
  if (
    kind === "kubernetes" &&
    /^\s*containers\s*:/m.test(content) &&
    !/securityContext/.test(content)
  ) {
    const rule = IAC_RULES.find((r) => r.id === K8S_MISSING_SECURITY_CONTEXT)
    if (rule && findingsInFile < MAX_FINDINGS_PER_FILE) {
      findingsInFile++
      findings.push({
        id: `${rule.id}-${relPath}`,
        title: `${rule.name} in ${relPath}`,
        severity: rule.severity,
        timestamp: new Date().toISOString(),
        target: relPath,
        cwe: rule.cwe,
        description: rule.description,
        technical_analysis: `${rule.name} — ${relPath} declares containers without any securityContext.`,
        impact: rule.impact,
        remediation_steps: rule.remediation,
        poc_description: `Inspect ${relPath}: containers are declared with no securityContext block.`,
        ...(rule.controlIds ? { control_ids: rule.controlIds } : {}),
        code_locations: [{ file: relPath, start_line: 1, label: rule.name }],
      })
    }
  }

  const variableContexts = kind === "terraform" ? terraformVariableContexts(content) : []
  for (const [index, line] of lines.entries()) {
    if (findingsInFile >= MAX_FINDINGS_PER_FILE || findings.length >= MAX_TOTAL_FINDINGS) {
      findingLimitReached = true
      break
    }
    if (isCommentOrBlank(line)) continue
    for (const rule of IAC_RULES) {
      if (findingsInFile >= MAX_FINDINGS_PER_FILE || findings.length >= MAX_TOTAL_FINDINGS) {
        findingLimitReached = true
        break
      }
      throwIfAborted(signal)
      if (rule.id === K8S_MISSING_SECURITY_CONTEXT) continue
      if (rule.id === "iac-dockerfile-latest-base" && !docker?.unpinned.has(index)) continue
      if (rule.id === "iac-dockerfile-user-root" && docker?.rootLine !== index) continue
      if (rule.id === "iac-compose-secret-env" && !environment?.has(index)) continue
      if (rule.id === "iac-tf-open-ingress" && !ingress?.has(index)) continue
      if (!kind || !rule.kinds.includes(kind)) continue
      if (rule.fileContext && !rule.fileContext.test(content)) continue
      if (rule.variableContext && !rule.variableContext.test(variableContexts[index] ?? ""))
        continue
      // Match and suppress on the code portion only — a trailing comment
      // (or a corpus CASE marker) must neither trigger nor hide a violation.
      const codePart = line.split("#")[0] ?? line
      const match = rule.pattern.exec(codePart)
      if (!match) continue
      if (rule.suppressIf?.test(codePart)) continue

      const lineNum = index + 1
      const findingId = `${rule.id}-${relPath}-${lineNum}`
      if (seenFindings.has(findingId)) continue
      seenFindings.add(findingId)
      findingsInFile++
      findings.push({
        id: findingId,
        title: `${rule.name} in ${relPath}:${lineNum}`,
        severity: rule.severity,
        timestamp: new Date().toISOString(),
        target: relPath,
        cwe: rule.cwe,
        description: rule.description,
        technical_analysis: `${rule.name} detected in ${relPath} at line ${lineNum}. Matched: ${match[0].slice(0, 120)}.`,
        impact: rule.impact,
        remediation_steps: rule.remediation,
        poc_description: `Review line ${lineNum} of ${relPath}: ${match[0].slice(0, 120)}.`,
        ...(rule.controlIds ? { control_ids: rule.controlIds } : {}),
        code_locations: [
          {
            file: relPath,
            start_line: lineNum,
            label: rule.name,
            snippet: line.trim().slice(0, 200),
          },
        ],
      })
    }
  }

  return findingLimitReached
}

export async function scanIac(config: IacScanConfig): Promise<EngineVulnerability[]> {
  const { repoPath, workspaceDir, signal, coverageIssues, discovery } = config
  throwIfAborted(signal)
  logger.info("Starting IaC scan", { repoPath })

  const candidates: string[] = []
  const walkState = {
    entries: 0,
    bounded: false,
    oversizedFiles: 0,
    unreadable: 0,
    phpSources: 0,
    symlinks: 0,
    phpDirectories: new Set<string>(),
    serviceDirectories: new Set<string>(),
  }
  await walkDir(repoPath, candidates, walkState, 0, signal)
  if (walkState.bounded) {
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "bounded",
      reason: "IaC file discovery reached its bounded repository walk limit",
    })
  }
  if (walkState.oversizedFiles > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "bounded",
      subject: `${walkState.oversizedFiles} file(s)`,
      reason: `Files exceeding the ${MAX_FILE_SIZE}-byte scanner limit were not inspected`,
    })
  }

  const skippedByReason = {
    oversized: walkState.oversizedFiles,
    walkBounded: walkState.bounded ? 1 : 0,
    unreadable: walkState.unreadable,
    findingLimit: 0,
    notIacContent: 0,
    testFixture: 0,
  }
  let bytesScanned = 0
  let filesScanned = 0

  const php = createPhpRuntimeDiscovery(
    workspaceDir,
    walkState.phpDirectories,
    coverageIssues,
    walkState.serviceDirectories
  )
  if (walkState.symlinks > 0)
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "partial",
      reason: "PHP/IaC symlink inputs were not followed; runtime coverage is incomplete",
    })
  const findings: EngineVulnerability[] = []
  const seenFindings = new Set<string>()

  for (const [fileIndex, filePath] of candidates.sort().entries()) {
    throwIfAborted(signal)
    if (findings.length >= MAX_TOTAL_FINDINGS) {
      skippedByReason.findingLimit += candidates.length - fileIndex
      recordCoverageIssue(coverageIssues, {
        scanner: "iac",
        status: "bounded",
        reason: `IaC finding cap of ${MAX_TOTAL_FINDINGS} reached; remaining files not fully reported`,
      })
      break
    }
    const relPath = relative(workspaceDir, filePath)
    if (/(?:^|\/)(?:__tests__|fixtures?|testdata|examples?|e2e)(?:\/|$)/i.test(relPath)) {
      skippedByReason.testFixture++
      continue
    }
    let content: string
    try {
      content = await readFile(filePath, "utf-8")
    } catch {
      skippedByReason.unreadable++
      continue
    }
    const kind = classify(filePath, content)
    if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
      recordCoverageIssue(coverageIssues, {
        scanner: "iac",
        status: "bounded",
        subject: relPath,
        reason: "PHP/IaC input grew beyond its bounded read limit",
      })
      continue
    }
    const runtime = php.inspect(relPath, filePath, content, kind)
    const runtimeCapacity = Math.min(MAX_FINDINGS_PER_FILE, MAX_TOTAL_FINDINGS - findings.length)
    findings.push(...runtime.findings.slice(0, runtimeCapacity))
    if (runtime.findings.length > runtimeCapacity)
      recordCoverageIssue(coverageIssues, {
        scanner: "iac",
        status: "bounded",
        subject: relPath,
        reason: "PHP runtime finding limit reached",
      })
    if (!kind && !isPhpRuntimeInput(basename(filePath))) {
      skippedByReason.notIacContent++
      continue
    }
    bytesScanned += Buffer.byteLength(content, "utf-8")
    filesScanned++

    let findingsInFile = Math.min(runtime.findings.length, runtimeCapacity)
    let findingLimitReached = false

    findingLimitReached = inspectIacContent(
      content,
      kind,
      relPath,
      findings,
      seenFindings,
      signal,
      findingsInFile
    )
    if (findingLimitReached) {
      skippedByReason.findingLimit++
      recordCoverageIssue(coverageIssues, {
        scanner: "iac",
        status: "bounded",
        subject: relPath,
        reason: "IaC finding limit reached; this file was not fully evaluated",
      })
    }
  }

  const phpContext = php.finish(
    walkState.bounded ||
      walkState.oversizedFiles > 0 ||
      skippedByReason.unreadable > 0 ||
      skippedByReason.findingLimit > 0 ||
      walkState.symlinks > 0
  )

  if (skippedByReason.unreadable > 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "iac",
      status: "partial",
      reason: `IaC could not read or inspect ${skippedByReason.unreadable} repository entries`,
    })
  }

  if (discovery) {
    discovery.iac = {
      filesScanned,
      bytesScanned,
      skippedByReason,
      representativeSkippedPaths: undefined,
      php: phpContext,
    }
  }

  logger.info("IaC scan complete", {
    repoPath,
    findingCount: findings.length,
    filesScanned,
  })
  return findings
}
