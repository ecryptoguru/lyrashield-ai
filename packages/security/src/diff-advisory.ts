/**
 * Shared advisory diff analyzer.
 *
 * One analyzer serves `lyrashield check-diff`/`lyrashield gate` (CLI, git
 * subprocesses upstream) and `lyrashield_check_diff` (MCP, caller-supplied
 * input). This module is also imported by browser bundles, so it must never
 * import node builtins: every input is caller-supplied text — file paths are
 * labels for supplied content, never filesystem access, and a unified diff is
 * never used to reconstruct missing source.
 *
 * Two detector families run over the same parsed input:
 *
 * - `DIFF_ADVISORY_RULES` — the merged risky-pattern table (the CLI's
 *   `RISKY_PATTERNS` rules, mirrored by `action.yml`, and the MCP tool's
 *   `DIFF_ADVISORY_PATTERNS`). Rules match added lines; in diff mode added
 *   lines whose content starts with `//` or `++` are skipped (historic CLI
 *   exclusions — `++` is ambiguous with the `+++` header).
 * - WebMCP discovery (`webmcp/discover` + `webmcp/evaluate`) over supplied
 *   file snapshots, with signals reported only when they intersect lines the
 *   diff actually added.
 *
 * Coverage is explicit and honest: scope is always "supplied-inputs" and
 * state is COMPLETE only when every supplied input and every file the diff
 * touches was analyzable within limits. Snippet-only input (no `files`) is
 * always INCOMPLETE — pattern checks ran, but full-file context was not
 * supplied.
 */

import { evaluateWebMcpSurface, WEBMCP_CONTROLS_BY_ID } from "./webmcp"
import { discoverWebMcpTools } from "./webmcp/discover"
import type { WebMcpScanFile, WebMcpSignal } from "./webmcp"

export type DiffAdvisorySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"

export interface DiffAdvisoryRule {
  ruleId: string
  severity: DiffAdvisorySeverity
  /** Short human-readable label; `message` appends " in <file>" when known. */
  label: string
  regex: RegExp
}

/**
 * Canonical risky-pattern table — union of the CLI's `RISKY_PATTERNS` and the
 * MCP tool's `DIFF_ADVISORY_PATTERNS`:
 *
 * - `hardcoded-secret` keeps ruleId/severity; its keyword set is the union of
 *   both copies (`passwd`, `bearer`, `api-key` came from the MCP copy).
 * - `eval` (MCP) is folded into `eval-exec` (CLI): `eval(`/`exec(` added calls
 *   report once under `eval-exec` at HIGH; member calls like `re.exec()` stay
 *   unflagged by both rule families — a deliberate false-positive guard.
 * - `child-process` keeps ruleId/severity for the `child_process` token; the
 *   MCP regex also matched bare `exec(`, which `eval-exec` already reports —
 *   deduplicated here to avoid double findings.
 * - `private-key`, `aws-key`, `dangerous-html`, `sql-concat` keep MCP ruleIds
 *   and gain severities (they were severity-free labels in the MCP output).
 */
export const DIFF_ADVISORY_RULES: DiffAdvisoryRule[] = [
  {
    ruleId: "hardcoded-secret",
    severity: "MEDIUM",
    label: "Potential hardcoded secret",
    regex: /(password|passwd|secret|api[_-]?key|token|bearer)\s*[=:]\s*["'][^"']{8,}["']/i,
  },
  {
    ruleId: "sql-injection",
    severity: "MEDIUM",
    label: "Potential SQL injection",
    regex: /(SELECT|INSERT|UPDATE|DELETE).*\+.*\$\{/i,
  },
  {
    ruleId: "disabled-security-control",
    severity: "MEDIUM",
    label: "Security control may be disabled",
    regex: /(csrf|cors|xss|helmet|secure)\s*[:=]\s*(false|disabled|off|none)/i,
  },
  {
    ruleId: "eval-exec",
    severity: "HIGH",
    label: "Use of eval/exec",
    regex: /(^|[^.\w])(eval|exec)\s*\(/i,
  },
  {
    ruleId: "private-key",
    severity: "HIGH",
    label: "Embedded private key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    ruleId: "aws-key",
    severity: "HIGH",
    label: "Possible AWS access key id",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    ruleId: "dangerous-html",
    severity: "MEDIUM",
    label: "React dangerouslySetInnerHTML",
    regex: /dangerouslySetInnerHTML/,
  },
  {
    ruleId: "sql-concat",
    severity: "MEDIUM",
    label: "Possible SQL string concatenation",
    regex: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*?["'`]\s*\+\s*\w/i,
  },
  {
    ruleId: "child-process",
    severity: "MEDIUM",
    label: "Shell/child_process execution",
    regex: /child_process/,
  },
]

export const DIFF_ADVISORY_LIMITS = {
  /** Entire `diff` input; larger inputs are rejected before parsing. */
  maxDiffBytes: 10 * 1024 * 1024,
  /** Supplied `files` entries accepted before bounding. */
  maxFiles: 500,
  /** Per supplied file content. */
  maxFileBytes: 1024 * 1024,
  /** Aggregate supplied file content admitted to WebMCP discovery. */
  maxTotalBytes: 10 * 1024 * 1024,
  /** WebMCP tool definitions per analysis. */
  maxDefinitions: 500,
  /** Findings emitted per analysis; beyond this, coverage is INCOMPLETE. */
  maxFindings: 500,
  /** Characters retained from a matched line for display. */
  maxLineSnippet: 200,
} as const

export interface DiffAdvisoryInput {
  /** Unified diff text or a bare code snippet (snippet mode scans all non-removed lines). */
  diff: string
  /**
   * Optional full-file snapshots keyed by path label. Supplying the changed
   * files' contents enables WebMCP structural analysis; omitting `files` is
   * always INCOMPLETE coverage (full-file context not supplied).
   */
  files?: Array<{ path: string; content: string }>
}

export interface DiffAdvisoryFinding {
  ruleId: string
  severity: DiffAdvisorySeverity
  /** Short rule/control label. */
  label: string
  message: string
  file?: string
  /** New-file line number for diff input; input line number for snippets. */
  line?: number
  /** Matched line content (truncated), when available. */
  match?: string
  source: "pattern" | "webmcp"
}

export interface DiffAdvisoryCoverage {
  state: "COMPLETE" | "INCOMPLETE"
  /** Only caller-supplied inputs were analyzed — never the whole repository. */
  scope: "supplied-inputs"
  reasons: string[]
}

export interface DiffAdvisoryResult {
  findings: DiffAdvisoryFinding[]
  coverage: DiffAdvisoryCoverage
  stats: {
    changedFiles: number
    suppliedFiles: number
    scannedFiles: number
    checkedLines: number
  }
}

export class DiffAdvisoryInputError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = "DiffAdvisoryInputError"
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Input validation — runs before any parsing. Paths are labels for supplied
// content: traversal, absolute and ambiguous spellings are rejected outright.
// ---------------------------------------------------------------------------

// Written via fromCharCode so the NUL check survives source transforms.
const NUL_BYTE = String.fromCharCode(0)

function validatePathLabel(path: string): void {
  if (typeof path !== "string" || path.length === 0 || !path.trim()) {
    throw new DiffAdvisoryInputError("invalid_path", "file path must be a non-empty string")
  }
  if (path.includes(NUL_BYTE)) {
    throw new DiffAdvisoryInputError("nul_byte", "file path must not contain NUL bytes")
  }
  if (path.includes("\\")) {
    throw new DiffAdvisoryInputError(
      "invalid_path",
      "file path must use forward slashes (backslash is ambiguous)"
    )
  }
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new DiffAdvisoryInputError("invalid_path", "file path must be relative, not absolute")
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new DiffAdvisoryInputError(
        "invalid_path",
        `file path ${JSON.stringify(path)} contains a traversal or empty segment`
      )
    }
  }
}

function validateInput(input: DiffAdvisoryInput): void {
  if (!input || typeof input !== "object") {
    throw new DiffAdvisoryInputError("invalid_input", "input must be an object with a diff string")
  }
  if (typeof input.diff !== "string") {
    throw new DiffAdvisoryInputError("invalid_input", "diff must be a string")
  }
  if (input.diff.includes(NUL_BYTE)) {
    throw new DiffAdvisoryInputError("nul_byte", "diff must not contain NUL bytes")
  }
  if (utf8Length(input.diff) > DIFF_ADVISORY_LIMITS.maxDiffBytes) {
    throw new DiffAdvisoryInputError(
      "diff_too_large",
      `diff exceeds the ${DIFF_ADVISORY_LIMITS.maxDiffBytes}-byte advisory limit`
    )
  }
  if (input.files === undefined) return
  if (!Array.isArray(input.files)) {
    throw new DiffAdvisoryInputError("invalid_files", "files must be an array of {path, content}")
  }
  const seen = new Set<string>()
  const seenLower = new Set<string>()
  for (const entry of input.files) {
    if (!entry || typeof entry !== "object") {
      throw new DiffAdvisoryInputError(
        "invalid_files",
        "files entries must be {path: string, content: string} objects"
      )
    }
    const { path, content } = entry
    validatePathLabel(path)
    if (typeof content !== "string") {
      throw new DiffAdvisoryInputError(
        "invalid_files",
        `file content for ${JSON.stringify(path)} must be a string`
      )
    }
    if (content.includes(NUL_BYTE)) {
      throw new DiffAdvisoryInputError(
        "nul_byte",
        `file ${JSON.stringify(path)} content must not contain NUL bytes`
      )
    }
    if (seen.has(path)) {
      throw new DiffAdvisoryInputError(
        "duplicate_path",
        `duplicate file path ${JSON.stringify(path)}`
      )
    }
    const lower = path.toLowerCase()
    if (seenLower.has(lower)) {
      throw new DiffAdvisoryInputError(
        "duplicate_path",
        `ambiguous file path ${JSON.stringify(path)} collides with another supplied path`
      )
    }
    seen.add(path)
    seenLower.add(lower)
  }
}

// ---------------------------------------------------------------------------
// Small path helpers (browser-safe stand-ins for node:path over "/" labels).
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder()

function utf8Length(text: string): number {
  return textEncoder.encode(text).length
}

function pathBasename(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? path : path.slice(index + 1)
}

function pathExtension(path: string): string {
  const base = pathBasename(path)
  const index = base.lastIndexOf(".")
  if (index <= 0) return ""
  return base.slice(index).toLowerCase()
}

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

/** Whether a path label can be structurally analyzed for WebMCP surface. */
export function isWebMcpEligiblePath(path: string): boolean {
  return (
    WEBMCP_CONFIG_NAMES.has(pathBasename(path)) ||
    WEBMCP_SUPPORTED_EXTENSIONS.has(pathExtension(path))
  )
}

/** Whether a path label is code-like but unsupported by WebMCP discovery. */
export function isWebMcpUnsupportedCodePath(path: string): boolean {
  return WEBMCP_CODE_LIKE_EXTENSIONS.has(pathExtension(path))
}

// ---------------------------------------------------------------------------
// Unified-diff parsing (hunk headers, file attribution, added-line tracking).
// ---------------------------------------------------------------------------

// Git emits one short hunk-header line here; input is not arbitrary file content.
// eslint-disable-next-line security/detect-unsafe-regex
const HUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/

function parseHunkHeader(line: string): { newStart: number } | null {
  const match = line.match(HUNK_HEADER)
  if (!match) return null
  return { newStart: Number.parseInt(match[1]!, 10) }
}

interface ParsedDiffFile {
  path: string | undefined
  addedLines: Array<{ line: number | undefined; text: string }>
  /** New-file line numbers of added lines, for signal∩diff intersection. */
  addedLineNumbers: Set<number>
  binary: boolean
  deleted: boolean
}

interface ParsedDiff {
  mode: "diff" | "snippet"
  /** Path-attributed files plus an unattributed bucket (bare hunks), ordered. */
  files: ParsedDiffFile[]
  byPath: Map<string, ParsedDiffFile>
  malformedHunks: number
  /** Raw lines, retained for snippet-mode scanning when no diff structure. */
  allLines: string[]
}

function newParsedFile(path: string | undefined): ParsedDiffFile {
  return { path, addedLines: [], addedLineNumbers: new Set(), binary: false, deleted: false }
}

/** Unquote a C-style-quoted git path token ("b/weird name"). */
function unquoteGitPath(token: string): string {
  if (!token.startsWith('"')) return token
  try {
    const parsed: unknown = JSON.parse(token)
    return typeof parsed === "string" ? parsed : token.slice(1, -1)
  } catch {
    return token.slice(1, -1)
  }
}

/** Extract the `b/…` (new) path from a `diff --git` header line. */
function pathFromDiffGitLine(line: string): string | undefined {
  const rest = line.slice("diff --git ".length).trimEnd()
  if (rest.startsWith('"')) {
    const match = rest.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/)
    if (!match || match[2] === undefined) return undefined
    const inner = unquoteGitPath(`"${match[2]}"`)
    return inner.startsWith("b/") ? inner.slice(2) : inner
  }
  const tokens = rest.split(/\s+/)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!
    if (token.startsWith("b/")) return token.slice(2)
  }
  return undefined
}

function parseUnifiedDiff(diff: string): ParsedDiff {
  const allLines = diff.split("\n")
  const files: ParsedDiffFile[] = []
  const byPath = new Map<string, ParsedDiffFile>()
  const unattributed = newParsedFile(undefined)
  let unattributedListed = false

  let current: ParsedDiffFile | undefined
  let inHunk = false
  let newLine = 0
  let lineNumbersKnown = true
  let sawStructure = false
  let malformedHunks = 0

  const fileFor = (path: string | undefined): ParsedDiffFile => {
    if (path === undefined) {
      if (!unattributedListed) {
        files.push(unattributed)
        unattributedListed = true
      }
      return unattributed
    }
    const existing = byPath.get(path)
    if (existing) return existing
    const created = newParsedFile(path)
    byPath.set(path, created)
    files.push(created)
    return created
  }

  for (const rawLine of allLines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith("diff --git ")) {
      sawStructure = true
      inHunk = false
      current = fileFor(pathFromDiffGitLine(line))
      continue
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      if (current) current.binary = true
      inHunk = false
      continue
    }

    if (inHunk && current) {
      // Inside a hunk, hunk-body line classes win over file-header shapes:
      // "--- x" is a removed line here, not a file preamble.
      const hunk = line.startsWith("@@") ? parseHunkHeader(line) : null
      if (hunk) {
        inHunk = true
        lineNumbersKnown = true
        newLine = hunk.newStart
        continue
      }
      if (line.startsWith("+")) {
        const content = line.slice(1)
        // Historic exclusions: added lines whose content starts with "//"
        // (comment) or "++" (ambiguous with the "+++" file header) are neither
        // scanned nor counted in the new-file line numbering.
        if (!content.startsWith("//") && !content.startsWith("++")) {
          const at = lineNumbersKnown ? newLine++ : undefined
          current.addedLines.push({ line: at, text: content })
          if (at !== undefined) current.addedLineNumbers.add(at)
        }
        continue
      }
      if (line.startsWith(" ")) {
        if (lineNumbersKnown) newLine++
        continue
      }
      if (line.startsWith("-") || line.startsWith("\\")) continue
      if (line === "") continue
      // Anything else ends the hunk body; structural handling resumes below.
      inHunk = false
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      sawStructure = true
      inHunk = false
      if (line.startsWith("+++ ")) {
        const token = line.slice(4)
        const path = unquoteGitPath(token)
        if (path === "/dev/null") {
          if (current) current.deleted = true
        } else {
          current = fileFor(path.startsWith("b/") ? path.slice(2) : path)
        }
      }
      continue
    }
    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line)
      if (hunk) {
        sawStructure = true
        inHunk = true
        lineNumbersKnown = true
        newLine = hunk.newStart
        current ??= fileFor(undefined)
      } else if (sawStructure) {
        // A "@@" line inside a structured diff that is not a valid hunk
        // header: following added lines are still scanned, but their line
        // numbers are untrusted and coverage is marked incomplete.
        malformedHunks++
        inHunk = true
        lineNumbersKnown = false
        current ??= fileFor(undefined)
      }
      // In snippet mode "@@" lines are ignored content (historic MCP behavior).
      continue
    }

    if (sawStructure) {
      // Structural lines (index, modes, similarity, rename, …) are ignored.
      // A bare "+" line outside any hunk is still scanned as an orphan added
      // line so partial diffs keep their detections.
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const content = line.slice(1)
        if (!content.startsWith("//") && !content.startsWith("++")) {
          ;(current ?? fileFor(undefined)).addedLines.push({ line: undefined, text: content })
        }
      }
      continue
    }
    // Pre-structure lines are snippet candidates; mode is decided post-pass.
  }

  return {
    mode: sawStructure ? "diff" : "snippet",
    files,
    byPath,
    malformedHunks,
    allLines,
  }
}

/** Snippet-mode line selection: everything not removed or a hunk header. */
function snippetLines(allLines: string[]): Array<{ line: number; text: string }> {
  const lines: Array<{ line: number; text: string }> = []
  for (let index = 0; index < allLines.length; index++) {
    const raw = allLines[index]!
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.startsWith("-") || line.startsWith("@@")) continue
    lines.push({ line: index + 1, text: line.startsWith("+") ? line.slice(1) : line })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export async function analyzeDiffAdvisory(input: DiffAdvisoryInput): Promise<DiffAdvisoryResult> {
  validateInput(input)

  const reasons = new Set<string>()
  const findings: DiffAdvisoryFinding[] = []
  let checkedLines = 0

  const emit = (finding: DiffAdvisoryFinding): boolean => {
    if (findings.length >= DIFF_ADVISORY_LIMITS.maxFindings) {
      reasons.add("max_findings")
      return false
    }
    findings.push(finding)
    return true
  }

  const parsed = parseUnifiedDiff(input.diff)

  // --- Synchronous pattern checks -----------------------------------------
  //
  // One finding per (rule, matched added line), plus a per-file joined-text
  // fallback so a match spanning an added-line boundary is still reported once
  // (the CLI historically checked the joined added text per file).
  const scanAddedLines = (
    filePath: string | undefined,
    addedLines: Array<{ line: number | undefined; text: string }>
  ): void => {
    const matchedRules = new Set<string>()
    let joined: string | undefined
    const offsets: number[] = []
    for (const { line, text } of addedLines) {
      checkedLines++
      let stop = false
      for (const rule of DIFF_ADVISORY_RULES) {
        if (!rule.regex.test(text)) continue
        matchedRules.add(rule.ruleId)
        const ok = emit({
          ruleId: rule.ruleId,
          severity: rule.severity,
          label: rule.label,
          message: filePath ? `${rule.label} in ${filePath}` : rule.label,
          file: filePath,
          line,
          match: text.trim().slice(0, DIFF_ADVISORY_LIMITS.maxLineSnippet),
          source: "pattern",
        })
        if (!ok) {
          stop = true
          break
        }
      }
      if (stop) return
      offsets.push(joined === undefined ? 0 : joined.length + 1)
      joined = joined === undefined ? text : `${joined}\n${text}`
    }
    if (joined === undefined) return
    for (const rule of DIFF_ADVISORY_RULES) {
      if (matchedRules.has(rule.ruleId)) continue
      const index = joined.search(rule.regex)
      if (index < 0) continue
      // Map the match offset back to the added line containing it.
      let line: number | undefined
      for (let i = 0; i < addedLines.length; i++) {
        const start = offsets[i] ?? 0
        const entry = addedLines[i]!
        if (index >= start && index < start + entry.text.length) {
          line = entry.line
          break
        }
      }
      if (
        !emit({
          ruleId: rule.ruleId,
          severity: rule.severity,
          label: rule.label,
          message: filePath ? `${rule.label} in ${filePath}` : rule.label,
          file: filePath,
          line,
          match: undefined,
          source: "pattern",
        })
      ) {
        return
      }
    }
  }

  if (parsed.mode === "diff") {
    if (parsed.malformedHunks > 0) reasons.add("malformed_hunk")
    for (const file of parsed.files) {
      scanAddedLines(file.path, file.addedLines)
    }
  } else {
    scanAddedLines(undefined, snippetLines(parsed.allLines))
  }

  // --- WebMCP structural analysis on supplied file snapshots ---------------

  const suppliedFiles = input.files
  const changedPaths = parsed.byPath
  const suppliedByPath = new Map<string, string>()
  const coverageReasons = reasons

  if (suppliedFiles === undefined) {
    // Snippet/diff-only input can still be pattern-checked, but structural
    // analysis needs full-file context that was not supplied.
    coverageReasons.add("full_file_context_not_supplied")
  } else {
    if (suppliedFiles.length > DIFF_ADVISORY_LIMITS.maxFiles) {
      coverageReasons.add("max_files")
    }
    for (const entry of suppliedFiles.slice(0, DIFF_ADVISORY_LIMITS.maxFiles)) {
      suppliedByPath.set(entry.path, entry.content)
    }
  }

  // Changed or supplied code-like files discovery cannot parse fail closed.
  let unsupportedCode = false
  for (const path of changedPaths.keys()) {
    if (isWebMcpUnsupportedCodePath(path)) unsupportedCode = true
  }
  for (const path of suppliedByPath.keys()) {
    if (isWebMcpUnsupportedCodePath(path)) unsupportedCode = true
  }
  if (unsupportedCode) coverageReasons.add("unsupported_language")

  const scanFiles: WebMcpScanFile[] = []
  let totalBytes = 0
  for (const [path, content] of suppliedByPath) {
    if (!isWebMcpEligiblePath(path)) continue
    const size = utf8Length(content)
    if (size > DIFF_ADVISORY_LIMITS.maxFileBytes) {
      coverageReasons.add("max_file_bytes")
      continue
    }
    if (totalBytes + size > DIFF_ADVISORY_LIMITS.maxTotalBytes) {
      coverageReasons.add("max_total_bytes")
      continue
    }
    totalBytes += size
    scanFiles.push({ path, content, size, extension: pathExtension(path), truncated: false })
  }

  // Eligible changed files with no supplied content cannot be structurally
  // analyzed (this also covers unreadable files reported by the CLI adapter).
  if (suppliedFiles !== undefined) {
    for (const path of changedPaths.keys()) {
      if (isWebMcpEligiblePath(path) && !suppliedByPath.has(path)) {
        coverageReasons.add("file_content_not_supplied")
      }
    }
  }

  if (scanFiles.length > 0) {
    let discovered: Awaited<ReturnType<typeof discoverWebMcpTools>> | undefined
    try {
      discovered = await discoverWebMcpTools(scanFiles, {
        limits: {
          maxFiles: DIFF_ADVISORY_LIMITS.maxFiles,
          maxFileBytes: DIFF_ADVISORY_LIMITS.maxFileBytes,
          maxTotalBytes: DIFF_ADVISORY_LIMITS.maxTotalBytes,
          maxDefinitions: DIFF_ADVISORY_LIMITS.maxDefinitions,
        },
      })
    } catch {
      coverageReasons.add("parser_error")
    }
    if (discovered) {
      const { inventory, context } = discovered
      for (const limit of inventory.limitsReached) coverageReasons.add(limit)
      if (inventory.incompleteDefinitions > 0) coverageReasons.add("incomplete_definitions")
      if (inventory.unsupportedFiles.length > 0) coverageReasons.add("unsupported_language")
      if (inventory.truncatedFiles.length > 0 && inventory.limitsReached.length === 0) {
        coverageReasons.add("truncated_files")
      }

      const signals = evaluateWebMcpSurface(scanFiles, inventory, context)
      for (const signal of signals) {
        if (signal.state !== "DETECTED") continue
        if (!signal.file || signal.line == null) continue
        const added = changedPaths.get(signal.file)?.addedLineNumbers
        const endLine = signal.endLine ?? signal.line
        if (!added || ![...added].some((line) => line >= signal.line! && line <= endLine)) {
          continue
        }
        if (!emit(webMcpSignalFinding(signal))) break
      }
    }
  }

  const sortedReasons = [...coverageReasons].sort()
  return {
    findings,
    coverage: {
      state: sortedReasons.length === 0 ? "COMPLETE" : "INCOMPLETE",
      scope: "supplied-inputs",
      reasons: sortedReasons,
    },
    stats: {
      changedFiles: changedPaths.size,
      suppliedFiles: suppliedFiles?.length ?? 0,
      scannedFiles: scanFiles.length,
      checkedLines,
    },
  }
}

function webMcpSignalFinding(signal: WebMcpSignal): DiffAdvisoryFinding {
  const control = WEBMCP_CONTROLS_BY_ID[signal.controlId]
  const label = control?.title ?? `WebMCP surface issue ${signal.controlId}`
  return {
    ruleId: signal.controlId,
    severity: signal.severity,
    label,
    message: control?.title ? `${control.title} (${signal.ruleId})` : label,
    file: signal.file,
    line: signal.line,
    match: signal.snippet,
    source: "webmcp",
  }
}
