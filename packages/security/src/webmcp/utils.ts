import { WEBMCP_CONTROLS_BY_ID } from "./controls"
import { sha256Sync } from "./hash"
import { WEBMCP_DETECTOR_VERSION } from "./types"
import type {
  WebMcpControlId,
  WebMcpEvidenceSource,
  WebMcpEvidenceState,
  WebMcpScanFile,
  WebMcpScanLimit,
  WebMcpSeverity,
  WebMcpSignal,
} from "./types"

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

const fileContentHashes = new WeakMap<WebMcpScanFile, string>()

function fileContentHash(file: WebMcpScanFile): string {
  const cached = fileContentHashes.get(file)
  if (cached) return cached
  const hash = sha256Sync(file.content)
  fileContentHashes.set(file, hash)
  return hash
}

export function computeEvidenceChecksum(
  file: WebMcpScanFile,
  state: WebMcpEvidenceState,
  controlId: WebMcpControlId,
  ruleId: string,
  line?: number,
  endLine?: number
): string {
  return sha256Sync(
    JSON.stringify({
      detectorVersion: WEBMCP_DETECTOR_VERSION,
      controlId,
      ruleId,
      state,
      path: file.path,
      size: file.size,
      truncated: file.truncated === true,
      contentHash: fileContentHash(file),
      line: line ?? null,
      endLine: endLine ?? null,
    })
  )
}

export function buildSignal(
  controlId: WebMcpControlId,
  ruleId: string,
  state: WebMcpEvidenceState,
  file: WebMcpScanFile,
  options?: {
    line?: number
    endLine?: number
    snippet?: string
    overrideRemediation?: string
    overrideSeverity?: WebMcpSeverity
    evidenceSource?: WebMcpEvidenceSource
  }
): WebMcpSignal {
  const control = WEBMCP_CONTROLS_BY_ID[controlId]
  const evidenceSource = options?.evidenceSource ?? "deterministic"
  const evidenceChecksum = computeEvidenceChecksum(
    file,
    state,
    controlId,
    ruleId,
    options?.line,
    options?.endLine
  )
  return {
    controlId,
    ruleId,
    state,
    severity: options?.overrideSeverity ?? control?.severity ?? "MEDIUM",
    file: file.path,
    line: options?.line,
    endLine: options?.endLine,
    snippet: options?.snippet,
    remediation:
      options?.overrideRemediation ??
      control?.remediationTemplate ??
      "Review the WebMCP tool surface and remediate.",
    evidenceSource,
    detectorVersion: WEBMCP_DETECTOR_VERSION,
    evidenceChecksum,
  }
}

export function detectedSignal(
  controlId: WebMcpControlId,
  ruleId: string,
  file: WebMcpScanFile,
  match: { start: number; end: number; severity?: WebMcpSeverity; remediation?: string }
): WebMcpSignal {
  const line = getLineNumber(file.content, match.start)
  const endLine = getLineNumber(file.content, match.end)
  const lineText = getLineAt(file.content, line)
  const snippet = getSnippet(file.content, match.start, match.end)
  const startColumn = match.start - file.content.lastIndexOf("\n", match.start - 1) - 1
  const boundedSnippet = `${lineText.slice(0, startColumn)}${snippet}`.slice(0, 120)
  return buildSignal(controlId, ruleId, "DETECTED", file, {
    line,
    endLine,
    snippet: boundedSnippet || snippet,
    overrideSeverity: match.severity,
    overrideRemediation: match.remediation,
  })
}

export function noFindingSignal(
  controlId: WebMcpControlId,
  ruleId: string,
  file: WebMcpScanFile
): WebMcpSignal {
  return buildSignal(controlId, ruleId, "NO_FINDING", file)
}

export function inconclusiveSignal(
  controlId: WebMcpControlId,
  ruleId: string,
  file: WebMcpScanFile,
  reason: string
): WebMcpSignal {
  return buildSignal(controlId, ruleId, "INCONCLUSIVE", file, {
    overrideRemediation: reason,
  })
}

export function notAssessedSignal(
  controlId: WebMcpControlId,
  ruleId: string,
  file: WebMcpScanFile,
  reason: string
): WebMcpSignal {
  return buildSignal(controlId, ruleId, "NOT_ASSESSED", file, {
    overrideRemediation: reason,
  })
}

export function buildProvenance(
  files: WebMcpScanFile[],
  limits: WebMcpScanLimit[],
  start: number
): { files: number; bytes: number; scannedAt: string } {
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    scannedAt: new Date(start).toISOString(),
  }
}

export function isProtectiveWording(text: string | null | undefined): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return (
    /\b(do not|don't|never|unsafe example|bad example|anti-pattern|dangerous|do not use)\b/.test(
      lower
    ) || /\bexample:.*\b(unsafe|dangerous|never)\b/.test(lower)
  )
}
