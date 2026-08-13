import { AI_SECURITY_CONTROLS_BY_ID } from "./controls"
import { AI_SECURITY_DETECTOR_VERSION } from "./types"
import type {
  AIControlId,
  AIScanFile,
  AIScanLimit,
  AISecurityEvidenceSource,
  AISecuritySeverity,
  AISecuritySignal,
  AISecuritySignalState,
} from "./types"

const SUPPORTED_LANGUAGES = new Set([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "json",
  "toml",
  "yaml",
  "yml",
])

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

export function isSupportedFile(file: AIScanFile): boolean {
  return (
    SUPPORTED_LANGUAGES.has(file.language ?? "unknown") &&
    SUPPORTED_EXTENSIONS.has(file.extension) &&
    file.truncated !== true
  )
}

export function isUnsupportedOrTruncated(file: AIScanFile): boolean {
  return !isSupportedFile(file)
}

export function getLineNumber(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++
  }
  return line
}

export function getLineAt(content: string, lineNumber: number): string {
  const lines = content.split("\n")
  return lines[lineNumber - 1] ?? ""
}

export function getSnippet(content: string, start: number, end: number, max = 120): string {
  const snippet = content.slice(Math.max(0, start), Math.min(content.length, end))
  return snippet.length > max ? `${snippet.slice(0, max)}…` : snippet
}

export function computeEvidenceChecksum(
  file: AIScanFile,
  state: AISecuritySignalState,
  line?: number
): string {
  const key = `${file.path}:${file.size}:${file.truncated}:${state}:${line ?? 0}`
  return cyrb53(key).toString(16)
}

function cyrb53(input: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export function buildSignal(
  controlId: AIControlId,
  ruleId: string,
  state: AISecuritySignalState,
  file: AIScanFile,
  options?: {
    evidenceSource?: AISecurityEvidenceSource
    line?: number
    snippet?: string
    overrideRemediation?: string
    overrideSeverity?: AISecuritySeverity
  }
): AISecuritySignal {
  const control = AI_SECURITY_CONTROLS_BY_ID[controlId]
  const line = options?.line
  const evidenceSource = options?.evidenceSource ?? "deterministic"
  const evidenceChecksum = computeEvidenceChecksum(file, state, line)

  let remediation = control.remediationTemplate
  if (options?.overrideRemediation) {
    remediation = options.overrideRemediation
  }

  const severity = options?.overrideSeverity ?? control.severity

  return {
    controlId,
    ruleId,
    owaspMapping: control.owaspMapping,
    state,
    severity,
    file: file.path,
    line,
    snippet: options?.snippet,
    remediation,
    evidenceSource,
    detectorVersion: AI_SECURITY_DETECTOR_VERSION,
    evidenceChecksum,
  }
}

export function detectedSignal(
  controlId: AIControlId,
  ruleId: string,
  file: AIScanFile,
  match: { start: number; end: number; severity?: AISecuritySeverity; remediation?: string }
): AISecuritySignal {
  const line = getLineNumber(file.content, match.start)
  const lineText = getLineAt(file.content, line)
  const snippet = getSnippet(file.content, match.start, match.end)
  const startColumn = match.start - file.content.lastIndexOf("\n", match.start - 1) - 1
  const boundedSnippet = `${lineText.slice(0, startColumn)}${snippet}`.slice(0, 120)
  return buildSignal(controlId, ruleId, "DETECTED", file, {
    line,
    snippet: boundedSnippet || snippet,
    overrideSeverity: match.severity,
    overrideRemediation: match.remediation,
  })
}

export function noFindingSignal(
  controlId: AIControlId,
  ruleId: string,
  file: AIScanFile
): AISecuritySignal {
  return buildSignal(controlId, ruleId, "NO_FINDING", file)
}

export function inconclusiveSignal(
  controlId: AIControlId,
  ruleId: string,
  file: AIScanFile,
  reason: string
): AISecuritySignal {
  return buildSignal(controlId, ruleId, "INCONCLUSIVE", file, {
    overrideRemediation: reason,
  })
}

export function notAssessedSignal(
  controlId: AIControlId,
  ruleId: string,
  file: AIScanFile,
  reason: string
): AISecuritySignal {
  return buildSignal(controlId, ruleId, "NOT_ASSESSED", file, {
    overrideRemediation: reason,
  })
}

export function extractCallBlock(content: string, startIndex: number): string {
  const openIndex = content.indexOf("(", startIndex)
  if (openIndex === -1) return ""

  let depth = 1
  let i = openIndex + 1
  while (i < content.length && depth > 0) {
    if (content[i] === "(") depth++
    if (content[i] === ")") depth--
    i++
  }

  return content.slice(openIndex, i)
}

export function buildProvenance(
  files: AIScanFile[],
  limits: AIScanLimit[],
  start: number
): {
  files: number
  bytes: number
  scannedAt: string
} {
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    scannedAt: new Date(start).toISOString(),
  }
}
