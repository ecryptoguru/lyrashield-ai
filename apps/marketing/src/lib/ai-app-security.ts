import {
  AI_SECURITY_CONTROLS,
  scanAiSecurityFiles,
  type AIScanFile,
  type AIScanLimits,
  type AIScanResult,
  type AISecuritySignal,
} from "@lyrashield/security/ai-security"

export const AI_APP_SECURITY_FREE_LIMITS: AIScanLimits = {
  maxFiles: 25,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxWallTimeMs: 30_000,
}

export const AI_APP_SECURITY_FREE_CONTROLS = [
  "AI-01",
  "AI-02",
  "AI-04",
  "AI-05",
  "AI-06",
  "AI-07",
  "AI-08",
] as const

export type AiAppSecurityUiSignal = {
  controlId: string
  controlTitle: string
  owasp: string
  state: string
  severity: string
  file?: string
  line?: number
  snippet?: string
  remediation: string
  evidenceSource: string
}

export type AiAppSecuritySummary = {
  detected: number
  noFinding: number
  inconclusive: number
  notAssessed: number
  total: number
  controls: Array<{
    id: string
    title: string
    state: string
    signalCount: number
  }>
}

function toLanguage(extension: string): AIScanFile["language"] {
  switch (extension.toLowerCase()) {
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

export async function readFilesForScan(files: File[]): Promise<AIScanFile[]> {
  const selected: AIScanFile[] = []
  for (const file of files.slice(0, AI_APP_SECURITY_FREE_LIMITS.maxFiles)) {
    const extension = file.name.slice(file.name.lastIndexOf("."))
    const content = await file.text()
    selected.push({
      path: file.name,
      content,
      size: content.length,
      extension,
      language: toLanguage(extension),
    })
  }
  return selected
}

export function pastedCodeForScan(code: string, extension = ".ts"): AIScanFile {
  return {
    path: `pasted-code${extension}`,
    content: code,
    size: code.length,
    extension,
    language: toLanguage(extension),
  }
}

export function runAiAppSecurityScan(files: AIScanFile[]): AIScanResult {
  return scanAiSecurityFiles(files, {
    limits: AI_APP_SECURITY_FREE_LIMITS,
    includeControls: [...AI_APP_SECURITY_FREE_CONTROLS],
  })
}

export function toUiSignals(result: AIScanResult): AiAppSecurityUiSignal[] {
  const controlById = new Map(AI_SECURITY_CONTROLS.map((c) => [c.id, c]))
  return result.signals.map((signal) => {
    const control = controlById.get(signal.controlId)
    return {
      controlId: signal.controlId,
      controlTitle: control?.title ?? signal.controlId,
      owasp: signal.owaspMapping,
      state: signal.state,
      severity: signal.severity,
      file: signal.file,
      line: signal.line,
      snippet: redactSnippet(signal.snippet),
      remediation: signal.remediation,
      evidenceSource: signal.evidenceSource,
    }
  })
}

function redactSnippet(snippet: AISecuritySignal["snippet"]): string | undefined {
  if (!snippet) return undefined
  if (snippet.length > 240) return `${snippet.slice(0, 240)}…`
  return snippet
}

export function buildSummary(result: AIScanResult): AiAppSecuritySummary {
  const controls = AI_SECURITY_CONTROLS.map((control) => {
    const coverage = result.coverage.controls[control.id]
    return {
      id: control.id,
      title: control.title,
      state: coverage?.state ?? "NOT_ASSESSED",
      signalCount: coverage?.signalCount ?? 0,
    }
  })

  return {
    detected: result.coverage.detectedCount,
    noFinding: result.coverage.noFindingCount,
    inconclusive: result.coverage.inconclusiveCount,
    notAssessed: result.coverage.notAssessedCount,
    total: result.coverage.totalControls,
    controls,
  }
}
