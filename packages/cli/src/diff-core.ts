import { execFile } from "node:child_process"
import process from "node:process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { CLI_VERSION } from "./version.js"
import { evaluateWebMcpSurface, WEBMCP_CONTROLS_BY_ID } from "@lyrashield/security/webmcp"
import { discoverWebMcpTools } from "@lyrashield/security/webmcp/discover"
import type { WebMcpScanFile, WebMcpSignal } from "@lyrashield/security/webmcp"

export interface DiffFinding {
  ruleId: string
  level: "error" | "warning" | "note"
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  message: string
  file?: string
  line?: number
  coverageIncomplete?: true
}

// Source of truth for the risky-pattern detector rules. The root `action.yml`
// embeds bash (grep -E) equivalents for CI runners without a Node runtime —
// `packages/cli/src/__tests__/action-patterns.drift.test.ts` fails when the
// two copies diverge, so change both together (that test first).
export const RISKY_PATTERNS: {
  ruleId: string
  severity: DiffFinding["severity"]
  regex: RegExp
  message: (file: string) => string
}[] = [
  {
    ruleId: "hardcoded-secret",
    severity: "MEDIUM",
    regex: /(password|secret|api_key|apikey|token)\s*[=:]\s*["'][^"']{8,}["']/i,
    message: (file) => `Potential hardcoded secret in ${file}`,
  },
  {
    ruleId: "sql-injection",
    severity: "MEDIUM",
    regex: /(SELECT|INSERT|UPDATE|DELETE).*\+.*\$\{/i,
    message: (file) => `Potential SQL injection in ${file}`,
  },
  {
    ruleId: "disabled-security-control",
    severity: "MEDIUM",
    regex: /(csrf|cors|xss|helmet|secure)\s*[:=]\s*(false|disabled|off|none)/i,
    message: (file) => `Security control may be disabled in ${file}`,
  },
  {
    ruleId: "eval-exec",
    severity: "HIGH",
    regex: /(^|[^.\w])(eval|exec)\s*\(/i,
    message: (file) => `Use of eval/exec in ${file}`,
  },
]

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

export function resolveDiffRange(
  staged: boolean,
  base?: string,
  head?: string
): { base: string; head: string } {
  if (staged) {
    return { base: "HEAD", head: "--cached" }
  }
  const b = base ?? "HEAD~1"
  const h = head ?? "HEAD"
  return { base: b, head: h }
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
          if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("+//")) {
            added.add(currentLine)
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

const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024

const WEBMCP_CONFIG_NAMES = new Set([
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "vercel.json",
  "_headers",
  ".htaccess",
  "nginx.conf",
])

const WEBMCP_SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".html",
  ".htm",
])

// Other source and component formats can embed browser-side WebMCP calls, but
// discovery does not parse them. Keep documentation and binary assets outside
// this list so unrelated changes do not fail the gate.
const WEBMCP_CODE_LIKE_EXTENSIONS = new Set([
  ".vue",
  ".svelte",
  ".mdx",
  ".marko",
  ".riot",
  ".hbs",
  ".handlebars",
  ".ejs",
  ".erb",
  ".pug",
  ".njk",
  ".nunjucks",
  ".php",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".cs",
  ".fs",
  ".fsx",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".lua",
  ".dart",
  ".elm",
  ".ex",
  ".exs",
  ".clj",
  ".cljs",
  ".groovy",
  ".gvy",
  ".pl",
  ".pm",
  ".r",
  ".sol",
  ".zig",
  ".nim",
  ".jl",
])

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

function webMcpSeverityToLevel(severity: WebMcpSignal["severity"]): DiffFinding["level"] {
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

function isWebMcpEligibleFile(path: string): boolean {
  const extension = extname(path).toLowerCase()
  const basename = path.split("/").pop() ?? ""
  return WEBMCP_CONFIG_NAMES.has(basename) || WEBMCP_SUPPORTED_EXTENSIONS.has(extension)
}

function isWebMcpUnsupportedCodeFile(path: string): boolean {
  return WEBMCP_CODE_LIKE_EXTENSIONS.has(extname(path).toLowerCase())
}

export async function runWebMcpDiffChecks(base: string, head: string): Promise<DiffFinding[]> {
  const changedFiles = await getChangedFiles(base, head)
  const files = changedFiles.filter(isWebMcpEligibleFile)
  const addedLineNumbers: Map<string, Set<number>> = new Map()
  const scanFiles: WebMcpScanFile[] = []
  const coverageGaps = new Set<string>()
  let totalBytes = 0

  if (changedFiles.some(isWebMcpUnsupportedCodeFile)) {
    coverageGaps.add("unsupported_language")
  }

  for (const file of files) {
    const content = await getChangedFileContent(head, file)
    if (content === undefined) {
      coverageGaps.add("unreadable_file")
      continue
    }
    const size = Buffer.byteLength(content, "utf-8")
    if (size > MAX_FILE_BYTES) {
      coverageGaps.add("max_file_bytes")
      continue
    }
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      coverageGaps.add("max_total_bytes")
      continue
    }
    totalBytes += size
    const added = await getAddedLineNumbers(base, head, file)
    addedLineNumbers.set(file, added)
    scanFiles.push({
      path: file,
      content,
      size,
      extension: extname(file).toLowerCase(),
      truncated: false,
    })
  }

  if (scanFiles.length === 0) {
    return coverageGaps.size > 0 ? [webMcpCoverageFinding(coverageGaps)] : []
  }

  let inventory: Awaited<ReturnType<typeof discoverWebMcpTools>>["inventory"]
  let context: Awaited<ReturnType<typeof discoverWebMcpTools>>["context"]
  try {
    ;({ inventory, context } = await discoverWebMcpTools(scanFiles, {
      limits: {
        maxFiles: 500,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxDefinitions: 500,
      },
    }))
  } catch {
    coverageGaps.add("parser_error")
    return [webMcpCoverageFinding(coverageGaps)]
  }
  for (const limit of inventory.limitsReached) coverageGaps.add(limit)
  if (inventory.incompleteDefinitions > 0) coverageGaps.add("incomplete_definitions")
  if (inventory.unsupportedFiles.length > 0) coverageGaps.add("unsupported_language")
  if (inventory.truncatedFiles.length > 0 && inventory.limitsReached.length === 0) {
    coverageGaps.add("truncated_files")
  }
  const signals = evaluateWebMcpSurface(scanFiles, inventory, context)

  const findings: DiffFinding[] = []
  for (const signal of signals) {
    if (signal.state !== "DETECTED") continue
    if (!signal.file || signal.line == null) continue
    const added = addedLineNumbers.get(signal.file)
    const endLine = signal.endLine ?? signal.line
    if (!added || ![...added].some((line) => line >= signal.line! && line <= endLine)) continue
    const control = WEBMCP_CONTROLS_BY_ID[signal.controlId]
    findings.push({
      ruleId: signal.controlId,
      level: webMcpSeverityToLevel(signal.severity),
      severity: signal.severity,
      message: control?.title
        ? `${control.title} (${signal.ruleId})`
        : `WebMCP surface issue ${signal.controlId}`,
      file: signal.file,
      line: signal.line,
    })
  }

  return coverageGaps.size > 0 ? [webMcpCoverageFinding(coverageGaps), ...findings] : findings
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
  const findings: DiffFinding[] = []
  for (const file of files) {
    const added = await getAddedLinesForFile(base, head, file)
    const text = added.join("\n")
    for (const pattern of RISKY_PATTERNS) {
      if (pattern.regex.test(text)) {
        findings.push({
          ruleId: pattern.ruleId,
          level:
            pattern.severity === "HIGH" || pattern.severity === "CRITICAL" ? "error" : "warning",
          severity: pattern.severity,
          message: pattern.message(file),
          file,
        })
      }
    }
  }
  return findings
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
