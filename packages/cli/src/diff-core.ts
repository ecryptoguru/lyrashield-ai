import { execFile } from "node:child_process"
import process from "node:process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { CLI_VERSION } from "./version.js"
import { WEBMCP_CONTROLS_BY_ID } from "@lyrashield/security/webmcp"
import {
  analyzeDiffAdvisory,
  isWebMcpEligiblePath,
  DIFF_ADVISORY_RULES,
  type DiffAdvisoryFinding,
  type DiffAdvisoryInput,
  type DiffAdvisoryResult,
  type DiffAdvisorySeverity,
} from "@lyrashield/security/diff-advisory"

export interface DiffFinding {
  ruleId: string
  level: "error" | "warning" | "note"
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  message: string
  file?: string
  line?: number
  coverageIncomplete?: true
}

// Source of truth for the risky-pattern detector rules is the shared
// DIFF_ADVISORY_RULES table in @lyrashield/security/diff-advisory (consumed by
// the CLI, the MCP check_diff tool, and derived here as RISKY_PATTERNS). The
// root `action.yml` embeds bash (grep -E) equivalents for CI runners without a
// Node runtime — `packages/cli/src/__tests__/action-patterns.drift.test.ts`
// fails when the two copies diverge, so change both together (that test
// first).
const RISKY_RULE_IDS = new Set([
  "hardcoded-secret",
  "sql-injection",
  "disabled-security-control",
  "eval-exec",
])

export const RISKY_PATTERNS: {
  ruleId: string
  severity: DiffFinding["severity"]
  regex: RegExp
  message: (file: string) => string
}[] = DIFF_ADVISORY_RULES.filter((rule) => RISKY_RULE_IDS.has(rule.ruleId)).map((rule) => ({
  ruleId: rule.ruleId,
  severity: rule.severity,
  regex: rule.regex,
  message: (file) => `${rule.label} in ${file}`,
}))

export function rankSeverity(s: string): number {
  switch (s.toUpperCase()) {
    case "CRITICAL":
      return 5
    case "HIGH":
      return 4
    case "MEDIUM":
      return 3
    case "LOW":
      return 2
    case "INFO":
      return 1
    default:
      return 0
  }
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/

/**
 * Resolve a caller-supplied ref to a 40-char commit SHA before it can reach
 * a git argv position. `rev-parse --verify --end-of-options` makes
 * option-looking input ("--output=…") a failed resolution instead of a git
 * option — every downstream `git diff`/`git show` then runs on verified
 * object ids only (VULN-E-001). The staged sentinel "--cached" is internal
 * and never reaches this function.
 */
async function resolveCommitRef(ref: string): Promise<string> {
  if (ref.startsWith("-")) {
    throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`)
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      { cwd: process.cwd() },
      (err, stdout) => {
        if (err) {
          return reject(new Error(`Cannot resolve git ref ${JSON.stringify(ref)} to a commit`))
        }
        const sha = stdout.trim()
        if (!GIT_OBJECT_ID.test(sha)) {
          return reject(new Error(`Cannot resolve git ref ${JSON.stringify(ref)} to a commit`))
        }
        resolve(sha)
      }
    )
  })
}

export async function resolveDiffRange(
  staged: boolean,
  base?: string,
  head?: string
): Promise<{ base: string; head: string }> {
  if (staged) {
    return { base: await resolveCommitRef("HEAD"), head: "--cached" }
  }
  const [resolvedBase, resolvedHead] = await Promise.all([
    resolveCommitRef(base ?? "HEAD~1"),
    resolveCommitRef(head ?? "HEAD"),
  ])
  return { base: resolvedBase, head: resolvedHead }
}

export async function getChangedFiles(base: string, head: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["diff", "--name-only", base, head], { cwd: process.cwd() }, (err, stdout) => {
      if (err) return reject(err)
      resolve(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      )
    })
  })
}

async function getFileDiff(base: string, head: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--unified=0", base, head, "--", file],
      { cwd: process.cwd() },
      (err, stdout) => {
        if (err) return reject(err)
        resolve(stdout)
      }
    )
  })
}

export async function getAddedLinesForFile(
  base: string,
  head: string,
  file: string
): Promise<string[]> {
  const stdout = await getFileDiff(base, head, file)
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++") && !l.startsWith("+//"))
    .map((l) => l.slice(1))
}

function parseHunkHeader(line: string): { newStart: number; newCount: number } | null {
  // Git emits one short hunk-header line here; input is not arbitrary file content.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/)
  if (!match) return null
  const newStart = Number.parseInt(match[1]!, 10)
  const newCount = match[2] ? Number.parseInt(match[2], 10) : 1
  return { newStart, newCount }
}

export async function getAddedLineNumbers(
  base: string,
  head: string,
  file: string
): Promise<Set<number>> {
  const stdout = await getFileDiff(base, head, file)
  const added = new Set<number>()
  let currentLine: number | null = null
  for (const line of stdout.split("\n")) {
    const header = parseHunkHeader(line)
    if (header) {
      currentLine = header.newStart
      continue
    }
    if (currentLine == null) continue
    if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("+//")) {
      added.add(currentLine)
      currentLine++
    } else if (line.startsWith(" ")) {
      currentLine++
    } else if (line.startsWith("-")) {
      // Removed lines do not advance the new-file line counter.
    }
  }
  return added
}

export async function getChangedFileContent(
  head: string,
  file: string
): Promise<string | undefined> {
  const staged = head === "--cached"
  const ref = staged ? "" : head
  const object = staged ? `:${file}` : `${ref}:${file}`
  return new Promise((resolve, reject) => {
    execFile("git", ["show", "--no-pager", object], { cwd: process.cwd() }, (err, stdout) => {
      if (err) {
        // If the file is not in the index or the requested commit, fall back
        // to the working tree as a last resort (e.g. unstaged local edits).
        // Path comes from `git diff --name-only`, scoped to the current repository.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (existsSync(file)) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          return void readFile(file, "utf-8")
            .then((content) => resolve(content))
            .catch(reject)
        }
        return resolve(undefined)
      }
      resolve(stdout)
    })
  })
}

// ---------------------------------------------------------------------------
// Shared-analyzer glue: git subprocesses collect { diff, files }, the analyzer
// in @lyrashield/security does the detection, and this adapter maps canonical
// findings back to the CLI's DiffFinding shape.
// ---------------------------------------------------------------------------

/** `diff --git` header synthesized when a collector returns hunk text only. */
function synthesizedDiffHeader(file: string): string {
  return `diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}\n`
}

/**
 * Collect the shared analyzer's input from the repository: the concatenated
 * per-file unified diff plus supplied content snapshots for WebMCP-eligible
 * files. Eligible files whose content cannot be read are simply not supplied;
 * the analyzer reports them as `file_content_not_supplied` (the former
 * `unreadable_file` gap) and coverage stays INCOMPLETE — fail closed.
 */
export async function collectDiffAdvisoryInput(
  base: string,
  head: string
): Promise<{ diff: string; files: { path: string; content: string }[] }> {
  const changedFiles = await getChangedFiles(base, head)
  const parts: string[] = []
  const files: { path: string; content: string }[] = []
  for (const file of changedFiles) {
    const body = await getFileDiff(base, head, file)
    parts.push(body.startsWith("diff --git") ? body : synthesizedDiffHeader(file) + body)
    if (isWebMcpEligiblePath(file)) {
      const content = await getChangedFileContent(head, file)
      if (content !== undefined) files.push({ path: file, content })
    }
  }
  return { diff: parts.join(""), files }
}

function advisorySeverityToLevel(severity: DiffAdvisorySeverity): DiffFinding["level"] {
  switch (severity) {
    case "CRITICAL":
    case "HIGH":
      return "error"
    case "MEDIUM":
    case "LOW":
      return "warning"
    case "INFO":
    default:
      return "note"
  }
}

function webMcpCoverageFinding(reasons: Iterable<string>): DiffFinding {
  const details = [...new Set(reasons)].sort().join(", ")
  return {
    ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
    level: "error",
    severity: "HIGH",
    message: `WebMCP diff coverage incomplete: ${details}`,
    coverageIncomplete: true,
  }
}

/** Canonical pattern findings collapse to one DiffFinding per (file, rule). */
function mapPatternFindings(findings: DiffAdvisoryFinding[]): DiffFinding[] {
  const byFile = new Map<string, Map<string, DiffAdvisoryFinding>>()
  const fileOrder: string[] = []
  for (const finding of findings) {
    const key = finding.file ?? ""
    let bucket = byFile.get(key)
    if (!bucket) {
      bucket = new Map()
      byFile.set(key, bucket)
      fileOrder.push(key)
    }
    if (!bucket.has(finding.ruleId)) bucket.set(finding.ruleId, finding)
  }
  const mapped: DiffFinding[] = []
  for (const fileKey of fileOrder) {
    const bucket = byFile.get(fileKey)!
    for (const rule of DIFF_ADVISORY_RULES) {
      const finding = bucket.get(rule.ruleId)
      if (!finding) continue
      mapped.push({
        ruleId: finding.ruleId,
        level: advisorySeverityToLevel(finding.severity),
        severity: finding.severity,
        message: finding.message,
        file: finding.file,
      })
    }
  }
  return mapped
}

function mapWebMcpFindings(findings: DiffAdvisoryFinding[]): DiffFinding[] {
  return findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: advisorySeverityToLevel(finding.severity),
    severity: finding.severity,
    message: finding.message,
    file: finding.file,
    line: finding.line,
  }))
}

/**
 * Map the shared analyzer's canonical result onto the CLI's DiffFinding
 * shape: pattern findings deduplicate to one per (file, rule) and an
 * INCOMPLETE coverage state becomes the fail-closed
 * WEBMCP-COVERAGE-INCOMPLETE pseudo-finding ahead of WebMCP signals.
 */
export function mapDiffAdvisoryResult(result: DiffAdvisoryResult): DiffFinding[] {
  const patternFindings = mapPatternFindings(result.findings.filter((f) => f.source === "pattern"))
  const webMcpFindings = mapWebMcpFindings(result.findings.filter((f) => f.source === "webmcp"))
  const coverage =
    result.coverage.state === "INCOMPLETE" ? [webMcpCoverageFinding(result.coverage.reasons)] : []
  return [...patternFindings, ...coverage, ...webMcpFindings]
}

/** Analyzer-only path (no git): supplied inputs in, CLI findings out. */
export async function runAdvisoryChecks(input: DiffAdvisoryInput): Promise<DiffFinding[]> {
  return mapDiffAdvisoryResult(await analyzeDiffAdvisory(input))
}

export async function runDiffChecks(base: string, head: string): Promise<DiffFinding[]> {
  return runAdvisoryChecks(await collectDiffAdvisoryInput(base, head))
}

export async function runRiskyPatternChecks(base: string, head: string): Promise<DiffFinding[]> {
  const changedFiles = await getChangedFiles(base, head)
  const parts: string[] = []
  for (const file of changedFiles) {
    const body = await getFileDiff(base, head, file)
    parts.push(body.startsWith("diff --git") ? body : synthesizedDiffHeader(file) + body)
  }
  const result = await analyzeDiffAdvisory({ diff: parts.join("") })
  return mapPatternFindings(result.findings.filter((f) => f.source === "pattern"))
}

export async function runWebMcpDiffChecks(base: string, head: string): Promise<DiffFinding[]> {
  const result = await analyzeDiffAdvisory(await collectDiffAdvisoryInput(base, head))
  const coverage =
    result.coverage.state === "INCOMPLETE" ? [webMcpCoverageFinding(result.coverage.reasons)] : []
  return [...coverage, ...mapWebMcpFindings(result.findings.filter((f) => f.source === "webmcp"))]
}

export interface SarifResult {
  ruleId: string
  level: string
  message: { text: string }
  locations?: { physicalLocation: { artifactLocation: { uri: string } } }[]
}

export function buildSarif(results: SarifResult[]): unknown {
  const webMcpRuleIds = new Set(
    results.map((r) => r.ruleId).filter((id) => id.startsWith("WEBMCP-"))
  )
  const rules = [...webMcpRuleIds].map((ruleId) => {
    const control = WEBMCP_CONTROLS_BY_ID[ruleId as keyof typeof WEBMCP_CONTROLS_BY_ID]
    return {
      id: ruleId,
      name: ruleId,
      shortDescription: {
        text: control?.title ?? `WebMCP rule ${ruleId}`,
      },
      fullDescription: {
        text: control?.description ?? `See WebMCP documentation for ${ruleId}.`,
      },
      helpUri: `https://docs.lyrashieldai.com/assurance/webmcp/${ruleId.toLowerCase()}`,
      defaultConfiguration: {
        level:
          control?.severity === "CRITICAL" || control?.severity === "HIGH"
            ? "error"
            : control?.severity === "MEDIUM" || control?.severity === "LOW"
              ? "warning"
              : "note",
      },
      properties: {
        tags: ["webmcp", "ai-agent-tool"],
      },
    }
  })

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "lyrashield",
            version: CLI_VERSION,
            informationUri: "https://github.com/ecryptoguru/lyrashield-ai",
            rules,
          },
        },
        results,
      },
    ],
  }
}
