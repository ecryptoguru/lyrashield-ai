import { execFile } from "node:child_process"
import process from "node:process"
import { CLI_VERSION } from "./version.js"
import { WEBMCP_CONTROLS_BY_ID } from "@lyrashield/security/webmcp"
import {
  analyzeDiffAdvisory,
  isWebMcpEligibleFile,
  RISKY_PATTERNS,
} from "@lyrashield/security/diff-advisory"
export { RISKY_PATTERNS }

export interface DiffFinding {
  ruleId: string
  level: "error" | "warning" | "note"
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  message: string
  file?: string
  line?: number
  coverageIncomplete?: true
}

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

export async function getAddedLinesForFile(
  base: string,
  head: string,
  file: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--unified=0", base, head, "--", file],
      { cwd: process.cwd() },
      (err, stdout) => {
        if (err) return reject(err)
        const lines = stdout
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++") && !l.startsWith("+//"))
          .map((l) => l.slice(1))
        resolve(lines)
      }
    )
  })
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
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--unified=0", base, head, "--", file],
      { cwd: process.cwd() },
      (err, stdout) => {
        if (err) return reject(err)
        const added = new Set<number>()
        let currentLine: number | null = null
        for (const line of stdout.split("\n")) {
          const header = parseHunkHeader(line)
          if (header) {
            currentLine = header.newStart
            continue
          }
          if (currentLine == null) continue
          if (line.startsWith("+") && !line.startsWith("+++")) {
            if (!line.startsWith("+//")) added.add(currentLine)
            currentLine++
          } else if (line.startsWith(" ")) {
            currentLine++
          } else if (line.startsWith("-")) {
            // Removed lines do not advance the new-file line counter.
          }
        }
        resolve(added)
      }
    )
  })
}

export async function getChangedFileContent(
  head: string,
  file: string
): Promise<string | undefined> {
  const staged = head === "--cached"
  const ref = staged ? "" : head
  const object = staged ? `:${file}` : `${ref}:${file}`
  return new Promise((resolve) => {
    execFile("git", ["show", "--no-pager", object], { cwd: process.cwd() }, (err, stdout) => {
      if (err) return resolve(undefined)
      resolve(stdout)
    })
  })
}

export async function runWebMcpDiffChecks(base: string, head: string): Promise<DiffFinding[]> {
  const changedFiles = await getChangedFiles(base, head)
  const snapshots: Array<{ path: string; content: string }> = []
  const parts: string[] = []
  let longLine = false
  for (const file of changedFiles) {
    // The shared analyzer receives supplied data only. Git access remains here.
    parts.push(`+++ b/${file}`)
    if (!isWebMcpEligibleFile(file)) continue
    const content = await getChangedFileContent(head, file)
    if (content !== undefined) snapshots.push({ path: file, content })
    const added = await getAddedLineNumbers(base, head, file)
    const lines = content?.split("\n") ?? []
    for (const number of added) {
      const text = lines[number - 1] ?? ""
      if (Buffer.byteLength(text) > 4096) {
        longLine = true
        continue
      }
      parts.push(`@@ -0,0 +${number} @@`, `+${text}`)
    }
  }
  let result: Awaited<ReturnType<typeof analyzeDiffAdvisory>>
  try {
    result = await analyzeDiffAdvisory({ diff: parts.join("\n"), files: snapshots })
  } catch {
    return [
      {
        ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
        level: "error",
        severity: "HIGH",
        message: "WebMCP diff coverage incomplete: invalid_or_oversized_input",
        coverageIncomplete: true,
      },
    ]
  }
  const findings: DiffFinding[] = result.findings
    .filter((finding) => finding.ruleId.startsWith("WEBMCP-"))
    .map((finding) => ({
      ...finding,
      level:
        finding.severity === "CRITICAL" || finding.severity === "HIGH"
          ? "error"
          : finding.severity === "INFO"
            ? "note"
            : "warning",
    }))
  const coverageReasons = [
    ...result.coverage.reasons,
    ...(longLine ? ["max_added_line_bytes"] : []),
  ]
  if (coverageReasons.length > 0) {
    findings.unshift({
      ruleId: "WEBMCP-COVERAGE-INCOMPLETE",
      level: "error",
      severity: "HIGH",
      message: `WebMCP diff coverage incomplete: ${coverageReasons.join(", ")}`,
      coverageIncomplete: true,
    })
  }
  return findings
}

export async function runDiffChecks(base: string, head: string): Promise<DiffFinding[]> {
  const [patternFindings, webMcpFindings] = await Promise.all([
    runRiskyPatternChecks(base, head),
    runWebMcpDiffChecks(base, head),
  ])
  return [...patternFindings, ...webMcpFindings]
}

export async function runRiskyPatternChecks(base: string, head: string): Promise<DiffFinding[]> {
  const files = await getChangedFiles(base, head)
  const diff: string[] = []
  for (const file of files) {
    const added = await getAddedLinesForFile(base, head, file)
    diff.push(`+++ b/${file}`, `@@ -0,0 +1,${added.length} @@`, ...added.map((line) => `+${line}`))
  }
  try {
    const result = await analyzeDiffAdvisory({ diff: diff.join("\n"), files: [] })
    return result.findings
      .filter((finding) => !finding.ruleId.startsWith("WEBMCP-"))
      .map((finding) => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        level: finding.severity === "HIGH" || finding.severity === "CRITICAL" ? "error" : "warning",
        message: finding.message,
        file: finding.file,
        line: finding.line,
      }))
  } catch {
    return [
      {
        ruleId: "DIFF-COVERAGE-INCOMPLETE",
        severity: "HIGH",
        level: "error",
        message: "Diff advisory coverage incomplete: input exceeds the analyzer limit",
        coverageIncomplete: true,
      },
    ]
  }
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
