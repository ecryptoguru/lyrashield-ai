export const AI_SECURITY_DETECTOR_VERSION = "ai-app-security/2026-08-21.1" as const

export const AI_SECURITY_SCORE_VERSION = "ai-app-security-score/1.0.0" as const

export type AIControlId =
  "AI-01" | "AI-02" | "AI-03" | "AI-04" | "AI-05" | "AI-06" | "AI-07" | "AI-08"

export type AIScanFileLanguage =
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "python"
  | "json"
  | "toml"
  | "yaml"
  | "yml"
  | "unknown"

export type AIScanFile = {
  path: string
  content: string
  size: number
  extension: string
  language?: AIScanFileLanguage
  truncated?: boolean
}

export type AISecuritySeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"

export type AISecuritySignalState = "DETECTED" | "NO_FINDING" | "INCONCLUSIVE" | "NOT_ASSESSED"

export type AISecurityEvidenceSource = "deterministic" | "advisory" | "agentic"

export type AIScanLimit =
  "max_files" | "max_file_bytes" | "max_total_bytes" | "max_wall_time_ms" | "unsupported_language"

export type AISecurityTriage = {
  disposition: "LIKELY_VALID" | "NEEDS_REVIEW" | "LIKELY_FALSE_POSITIVE"
  confidence: number
  explanation: string
  policyVersion: string
  modelRoute?: string
  redactionReceipt?: string
}

export type AISecuritySignal = {
  controlId: AIControlId
  ruleId: string
  owaspMapping: string
  state: AISecuritySignalState
  severity: AISecuritySeverity
  file?: string
  line?: number
  snippet?: string
  remediation: string
  evidenceSource: AISecurityEvidenceSource
  detectorVersion: string
  evidenceChecksum: string
  triage?: AISecurityTriage
}

export type AIControlCoverage = {
  controlId: AIControlId
  state: AISecuritySignalState
  assessed: boolean
  evidenceSource?: AISecurityEvidenceSource
  ruleIds: string[]
  fileCount: number
  signalCount: number
}

export type AISecurityCoverage = {
  version: string
  totalControls: number
  assessedCount: number
  notAssessedCount: number
  detectedCount: number
  noFindingCount: number
  inconclusiveCount: number
  controls: Record<AIControlId, AIControlCoverage>
  limitsReached: AIScanLimit[]
  unsupportedFiles: string[]
  truncatedFiles: string[]
}

export type AISecurityProvenance = {
  detectorVersion: string
  scannedAt: string
  files: number
  bytes: number
  limitsReached: AIScanLimit[]
}

export type AIScanLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxWallTimeMs: number
  allowedExtensions?: string[]
}

export type AIScanResult = {
  signals: AISecuritySignal[]
  coverage: AISecurityCoverage
  provenance: AISecurityProvenance
}

export type AISecurityControlDefinition = {
  id: AIControlId
  title: string
  owaspMapping: string
  description: string
  strategy: "deterministic" | "advisory"
  severity: AISecuritySeverity
  negativeEvidence: string
  falsePositiveNotes: string
  remediationTemplate: string
}
