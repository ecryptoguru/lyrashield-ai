import { extname } from "node:path"
import { evaluateWebMcpSurface, WEBMCP_CONTROLS_BY_ID } from "./webmcp/index"
import { discoverWebMcpTools } from "./webmcp/discover"
import type { WebMcpScanFile, WebMcpSignal } from "./webmcp/index"

export interface DiffAdvisoryInput {
  diff: string
  files?: Array<{ path: string; content: string }>
}

export interface DiffAdvisoryFinding {
  ruleId: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  message: string
  file?: string
  line?: number
  sourceLine?: string
}

export const RISKY_PATTERNS: Array<{
  ruleId: string
  severity: DiffAdvisoryFinding["severity"]
  regex: RegExp
  message: (file: string) => string
}> = [
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

const LEGACY_MCP_PATTERNS = [
  {
    ruleId: "hardcoded-secret",
    severity: "MEDIUM",
    regex: /(?:api[_-]?key|secret|token|password|passwd|bearer)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    message: "Possible hardcoded secret or API key",
  },
  {
    ruleId: "private-key",
    severity: "HIGH",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    message: "Embedded private key",
  },
  {
    ruleId: "aws-key",
    severity: "HIGH",
    regex: /AKIA[0-9A-Z]{16}/,
    message: "Possible AWS access key id",
  },
  {
    ruleId: "dangerous-html",
    severity: "MEDIUM",
    regex: /dangerouslySetInnerHTML/,
    message: "React dangerouslySetInnerHTML",
  },
  {
    ruleId: "sql-concat",
    severity: "MEDIUM",
    regex: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*?["'`]\s*\+\s*\w/i,
    message: "Possible SQL string concatenation",
  },
  {
    ruleId: "child-process",
    severity: "MEDIUM",
    regex: /child_process|exec\s*\(/,
    message: "Shell/child_process execution",
  },
] as const

const MAX_DIFF_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_FILES = 500
const MAX_DEFINITIONS = 500
const MAX_FINDINGS = 500
const CONFIG_NAMES = new Set([
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
])
const CODE_EXTENSIONS = new Set([
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

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === "." || !part)
  )
}

export function isWebMcpEligibleFile(path: string): boolean {
  return (
    CONFIG_NAMES.has(path.split("/").pop() ?? "") ||
    SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())
  )
}

function parseAddedLines(diff: string): {
  lines: Array<{ text: string; file?: string; line?: number }>
  added: Map<string, Set<number>>
  changed: Set<string>
  malformed: boolean
  deletedFile: boolean
} {
  const lines: Array<{ text: string; file?: string; line?: number }> = []
  const added = new Map<string, Set<number>>()
  const changed = new Set<string>()
  let file: string | undefined
  let line: number | undefined
  let sawHeader = false
  let malformed = false
  let deletedFile = false
  const unified = /^(?:diff --git |\+\+\+ )/m.test(diff)
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      sawHeader = true
      const path = raw.slice(4).trim()
      if (path === "/dev/null") deletedFile = true
      file = path === "/dev/null" ? undefined : path.startsWith("b/") ? path.slice(2) : path
      line = undefined
      if (file) {
        if (!validPath(file)) malformed = true
        else changed.add(file)
      }
    } else if (raw.startsWith("@@")) {
      // Git hunk header is bounded by MAX_DIFF_BYTES and matched once per line.
      // eslint-disable-next-line security/detect-unsafe-regex
      const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw)
      if (!match || !file) {
        malformed = true
        line = undefined
      } else line = Number(match[1])
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (sawHeader && line === undefined) {
        malformed = true
        continue
      }
      const text = raw.slice(1)
      lines.push({ text, file, line })
      if (file && line !== undefined) {
        const numbers = added.get(file) ?? new Set<number>()
        numbers.add(line)
        added.set(file, numbers)
        line++
      }
    } else if (raw.startsWith(" ") && line !== undefined) line++
    else if (!unified && !sawHeader && raw && !raw.startsWith("-")) lines.push({ text: raw })
  }
  return { lines, added, changed, malformed, deletedFile }
}

export async function analyzeDiffAdvisory(input: DiffAdvisoryInput): Promise<{
  findings: DiffAdvisoryFinding[]
  checked: number
  coverage: { state: "COMPLETE" | "INCOMPLETE"; scope: "supplied-inputs"; reasons: string[] }
}> {
  if (
    typeof input.diff !== "string" ||
    (input.files !== undefined && !Array.isArray(input.files))
  ) {
    throw new Error("Invalid diff advisory input")
  }
  if (Buffer.byteLength(input.diff) > MAX_DIFF_BYTES || (input.files?.length ?? 0) > MAX_FILES) {
    throw new Error("Diff advisory input exceeds limit")
  }
  const parsed = parseAddedLines(input.diff)
  const reasons = new Set<string>()
  if (parsed.malformed) reasons.add("malformed_hunk")
  if (parsed.deletedFile) reasons.add("deleted_file")
  if (!input.files) reasons.add("missing_source_snapshots")
  const files = new Map<string, string>()
  const seen = new Set<string>()
  let totalBytes = 0
  for (const entry of input.files ?? []) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.content !== "string" ||
      !validPath(entry.path) ||
      seen.has(entry.path)
    ) {
      throw new Error("Invalid or duplicate diff advisory file")
    }
    seen.add(entry.path)
    const bytes = Buffer.byteLength(entry.content)
    if (bytes > MAX_FILE_BYTES) {
      reasons.add("max_file_bytes")
      continue
    }
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      reasons.add("max_total_bytes")
      continue
    }
    totalBytes += bytes
    files.set(entry.path, entry.content)
  }
  const findings: DiffAdvisoryFinding[] = []
  const riskyText = new Map<string, string[]>()
  for (const added of parsed.lines) {
    const path = added.file ?? "<supplied-diff>"
    const bucket = riskyText.get(path) ?? []
    bucket.push(added.text)
    riskyText.set(path, bucket)
    for (const pattern of LEGACY_MCP_PATTERNS) {
      if (pattern.ruleId === "hardcoded-secret" && RISKY_PATTERNS[0]?.regex.test(added.text))
        continue
      if (pattern.regex.test(added.text)) {
        findings.push({
          ruleId: pattern.ruleId,
          severity: pattern.severity,
          message: pattern.message,
          file: added.file,
          line: added.line,
          sourceLine: added.text.trim().slice(0, 200),
        })
      }
    }
  }
  for (const [path, lines] of riskyText) {
    const text = lines.join("\n")
    for (const pattern of RISKY_PATTERNS) {
      if (pattern.regex.test(text)) {
        findings.push({
          ruleId: pattern.ruleId,
          severity: pattern.severity,
          message: pattern.message(path),
          file: path === "<supplied-diff>" ? undefined : path,
          sourceLine: lines
            .find((line) => pattern.regex.test(line))
            ?.trim()
            .slice(0, 200),
        })
      }
    }
  }
  if (input.files) {
    const scanFiles: WebMcpScanFile[] = []
    for (const path of parsed.changed) {
      if (CODE_EXTENSIONS.has(extname(path).toLowerCase())) reasons.add("unsupported_language")
      if (!isWebMcpEligibleFile(path)) continue
      const content = files.get(path)
      if (content === undefined) {
        reasons.add("missing_source_snapshots")
        continue
      }
      scanFiles.push({
        path,
        content,
        size: Buffer.byteLength(content),
        extension: extname(path).toLowerCase(),
        truncated: false,
      })
    }
    if (scanFiles.length > 0) {
      try {
        const { inventory, context } = await discoverWebMcpTools(scanFiles, {
          limits: {
            maxFiles: MAX_FILES,
            maxFileBytes: MAX_FILE_BYTES,
            maxTotalBytes: MAX_TOTAL_BYTES,
            maxDefinitions: MAX_DEFINITIONS,
          },
        })
        for (const limit of inventory.limitsReached) reasons.add(limit)
        if (inventory.incompleteDefinitions > 0) reasons.add("incomplete_definitions")
        if (inventory.unsupportedFiles.length > 0) reasons.add("unsupported_language")
        if (inventory.truncatedFiles.length > 0 && inventory.limitsReached.length === 0)
          reasons.add("truncated_files")
        for (const signal of evaluateWebMcpSurface(scanFiles, inventory, context)) {
          if (signal.state !== "DETECTED" || !signal.file || signal.line == null) continue
          const added = parsed.added.get(signal.file)
          if (
            !added ||
            ![...added].some(
              (line) => line >= signal.line! && line <= (signal.endLine ?? signal.line!)
            )
          )
            continue
          const control = WEBMCP_CONTROLS_BY_ID[signal.controlId]
          findings.push({
            ruleId: signal.controlId,
            severity: signal.severity as WebMcpSignal["severity"],
            message: control?.title
              ? `${control.title} (${signal.ruleId})`
              : `WebMCP surface issue ${signal.controlId}`,
            file: signal.file,
            line: signal.line,
          })
        }
      } catch {
        reasons.add("parser_error")
      }
    }
  }
  if (findings.length > MAX_FINDINGS) reasons.add("max_findings")
  return {
    findings: findings.slice(0, MAX_FINDINGS),
    checked: parsed.lines.length,
    coverage: {
      state: reasons.size ? "INCOMPLETE" : "COMPLETE",
      scope: "supplied-inputs",
      reasons: [...reasons].sort(),
    },
  }
}
