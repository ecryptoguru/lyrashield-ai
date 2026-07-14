/* eslint-disable security/detect-non-literal-fs-filename */
import { lstat, readFile, readdir } from "fs/promises"
import { join } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

export interface AgentConfigScanConfig {
  repoPath: string
  coverageIssues?: ScannerCoverageIssue[]
}

const INSTRUCTION_FILE_NAMES = new Set(["AGENTS.md", "CLAUDE.md", ".cursorrules", ".windsurfrules"])
const COPILOT_INSTRUCTIONS = ".github/copilot-instructions.md"
const MAX_FILE_BYTES = 512 * 1024
const MAX_WORKFLOWS = 100
const MAX_INSTRUCTION_WALK_ENTRIES = 20_000
const MAX_INSTRUCTION_WALK_DEPTH = 40
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
])

const DANGEROUS_INSTRUCTION_PATTERNS = [
  /ignore (?:all )?(?:previous|prior|system) instructions/i,
  /(?:disable|skip|bypass).{0,40}(?:security|tests?|review|approval)/i,
  /(?:upload|send|exfiltrate).{0,50}(?:\.env|secrets?|credentials?|tokens?)/i,
  /curl\s+[^|\n]+\|\s*(?:ba)?sh\b/i,
  /\brm\s+-rf\s+(?:\/|~|\$HOME)\b/i,
]
const PROTECTIVE_INSTRUCTION_PATTERNS = [
  /^(?:do not|never|must not)\s+ignore (?:all )?(?:previous|prior|system) instructions?\s*[.!]?$/i,
  /^(?:do not|never|must not)\s+(?:disable|skip|bypass).{0,40}(?:security|tests?|review|approval)\s*[.!]?$/i,
  /^(?:do not|never|must not)\s+(?:upload|send|exfiltrate).{0,50}(?:\.env|secrets?|credentials?|tokens?)\s*[.!]?$/i,
]

function finding(
  id: string,
  title: string,
  severity: string,
  cwe: string,
  description: string,
  remediation_steps: string,
  file: string,
  line: number,
  snippet: string
): EngineVulnerability {
  return {
    id,
    title,
    severity,
    timestamp: new Date().toISOString(),
    target: file,
    cwe,
    description,
    remediation_steps,
    code_locations: [{ file, start_line: line, end_line: line, snippet: snippet.slice(0, 240) }],
  }
}

async function readBoundedFile(
  repoPath: string,
  file: string,
  coverageIssues?: ScannerCoverageIssue[]
): Promise<string | null> {
  try {
    const fullPath = join(repoPath, file)
    const stat = await lstat(fullPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    if (stat.size > MAX_FILE_BYTES) {
      recordCoverageIssue(coverageIssues, {
        scanner: "agent_config",
        status: "bounded",
        subject: file,
        reason: `Instruction file exceeds the ${MAX_FILE_BYTES}-byte scanner limit`,
      })
      return null
    }
    return await readFile(fullPath, "utf8")
  } catch {
    return null
  }
}

async function findInstructionFiles(
  repoPath: string,
  coverageIssues?: ScannerCoverageIssue[]
): Promise<string[]> {
  const found: string[] = []
  const state = { entries: 0, bounded: false }

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_INSTRUCTION_WALK_DEPTH || state.entries >= MAX_INSTRUCTION_WALK_ENTRIES) {
      state.bounded = true
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++state.entries > MAX_INSTRUCTION_WALK_ENTRIES) {
        state.bounded = true
        break
      }
      if (entry.isSymbolicLink()) continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(join(directory, entry.name), relativePath, depth + 1)
        }
      } else if (
        entry.isFile() &&
        (INSTRUCTION_FILE_NAMES.has(entry.name) || relativePath === COPILOT_INSTRUCTIONS)
      ) {
        found.push(relativePath)
      }
    }
  }

  await visit(repoPath, "", 0)
  if (state.bounded) {
    recordCoverageIssue(coverageIssues, {
      scanner: "agent_config",
      status: "bounded",
      reason: "Instruction-file discovery reached its bounded repository walk limit",
    })
  }
  return found
}

async function scanInstructionFiles(
  repoPath: string,
  coverageIssues?: ScannerCoverageIssue[]
): Promise<EngineVulnerability[]> {
  const findings: EngineVulnerability[] = []
  for (const file of await findInstructionFiles(repoPath, coverageIssues)) {
    const content = await readBoundedFile(repoPath, file, coverageIssues)
    if (!content) continue
    let inCodeFence = false
    for (const [index, line] of content.split("\n").entries()) {
      if (line.trimStart().startsWith("```")) {
        inCodeFence = !inCodeFence
        continue
      }
      if (inCodeFence) continue
      const hasDangerousClause = line
        .split(/[;]|(?:\.\s+)/)
        .some(
          (clause) =>
            !PROTECTIVE_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(clause.trim())) &&
            DANGEROUS_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(clause))
        )
      if (!hasDangerousClause) continue
      findings.push(
        finding(
          `agent-instruction-poisoning-${file}-${index + 1}`,
          `Potential poisoned agent instruction in ${file}`,
          "HIGH",
          "CWE-94",
          "An agent instruction file contains a directive that can suppress security controls, expose secrets, or execute destructive commands.",
          "Remove the directive, require review for agent instruction changes, and keep agent tools least-privileged and approval-gated.",
          file,
          index + 1,
          line
        )
      )
    }
  }
  return findings
}

function findWritePermissionLine(lines: string[]): number {
  let permissionIndent: number | undefined
  for (const [index, line] of lines.entries()) {
    const withoutComment = line.split("#", 1)[0] ?? ""
    const permission = /^(\s*)permissions:\s*(.*)$/i.exec(withoutComment)
    if (permission) {
      const indent = permission[1]?.length ?? 0
      const value = permission[2]?.trim().toLowerCase() ?? ""
      if (value === "write-all" || /\b[a-z-]+\s*:\s*write\b/.test(value)) return index
      permissionIndent = value ? undefined : indent
      continue
    }
    if (permissionIndent === undefined || !withoutComment.trim()) continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    if (indent <= permissionIndent) {
      permissionIndent = undefined
      continue
    }
    if (/^\s*[a-z-]+\s*:\s*write\s*$/i.test(withoutComment)) return index
  }
  return -1
}

async function scanWorkflows(repoPath: string): Promise<EngineVulnerability[]> {
  const directory = join(repoPath, ".github/workflows")
  let files: string[]
  try {
    files = (await readdir(directory))
      .filter((file) => /\.ya?ml$/i.test(file))
      .slice(0, MAX_WORKFLOWS)
  } catch {
    return []
  }

  const findings: EngineVulnerability[] = []
  for (const fileName of files) {
    const file = `.github/workflows/${fileName}`
    const content = await readBoundedFile(repoPath, file)
    if (!content) continue
    const lines = content.split("\n")

    const writePermissionLine = findWritePermissionLine(lines)
    const writeAllLine = lines.findIndex(
      (line) => line.split("#", 1)[0]?.trim().toLowerCase() === "permissions: write-all"
    )
    if (writeAllLine >= 0) {
      findings.push(
        finding(
          `ci-write-all-${fileName}`,
          `CI workflow grants write-all permissions in ${fileName}`,
          "HIGH",
          "CWE-250",
          "The workflow grants every available GitHub token permission, increasing the impact of a compromised action or untrusted input.",
          "Replace write-all with the smallest job-level permissions required and keep contents read-only unless a reviewed step must write.",
          file,
          writeAllLine + 1,
          lines[writeAllLine] ?? ""
        )
      )
    }

    const usesPullRequestTarget = /^\s*pull_request_target\s*:/m.test(content)
    const checksOutHead = /github\.event\.pull_request\.head\.(?:sha|ref)/.test(content)
    const hasWritePermission = writePermissionLine >= 0
    if (usesPullRequestTarget && checksOutHead && hasWritePermission) {
      const line = lines.findIndex((candidate) => candidate.includes("pull_request_target")) + 1
      findings.push(
        finding(
          `ci-pull-request-target-confused-deputy-${fileName}`,
          `Privileged pull_request_target workflow checks out untrusted PR code in ${fileName}`,
          "CRITICAL",
          "CWE-441",
          "The workflow combines a privileged pull_request_target token with code from the pull request head, allowing attacker-controlled code to act with base-repository permissions.",
          "Use pull_request with read-only permissions for untrusted code. If pull_request_target is required, never execute or check out the pull request head in the privileged job.",
          file,
          line,
          lines[line - 1] ?? "pull_request_target"
        )
      )
    }
  }
  return findings
}

export async function scanAgentConfig(
  config: AgentConfigScanConfig
): Promise<EngineVulnerability[]> {
  const [instructionFindings, workflowFindings] = await Promise.all([
    scanInstructionFiles(config.repoPath, config.coverageIssues),
    scanWorkflows(config.repoPath),
  ])
  const findings = [...instructionFindings, ...workflowFindings]
  logger.info("Agent configuration scan complete", {
    repoPath: config.repoPath,
    findingCount: findings.length,
  })
  return findings
}
