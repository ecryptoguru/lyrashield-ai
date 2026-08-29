export const WEBMCP_DETECTOR_VERSION = "webmcp-assurance/1" as const

export type WebMcpDefinitionKind = "imperative" | "declarative"

export type WebMcpBehavior = "read" | "ui-only" | "mutation" | "unknown"

export type WebMcpEvidenceState = "DETECTED" | "NO_FINDING" | "INCONCLUSIVE" | "NOT_ASSESSED"

export type WebMcpSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"

export type WebMcpEvidenceSource = "deterministic" | "advisory"

export type WebMcpRuntimeValidation = "present" | "absent" | "unknown"

export type WebMcpScanLimit =
  | "max_files"
  | "max_file_bytes"
  | "max_total_bytes"
  | "max_definitions"
  | "max_wall_time_ms"
  | "max_walk_entries"
  | "max_walk_depth"
  | "unsupported_language"

export type WebMcpControlId =
  | "WEBMCP-01"
  | "WEBMCP-02"
  | "WEBMCP-03"
  | "WEBMCP-04"
  | "WEBMCP-05"
  | "WEBMCP-06"
  | "WEBMCP-07"
  | "WEBMCP-08"
  | "WEBMCP-09"
  | "WEBMCP-10"

export interface WebMcpScanFile {
  path: string
  content: string
  size: number
  extension: string
  language?: string
  truncated?: boolean
}

export interface WebMcpSchemaProperty {
  name: string
  type: string
  required: boolean
  description?: string
  bounded?: boolean
}

export interface NormalizedSchemaSummary {
  title?: string
  description?: string
  type: string
  properties?: WebMcpSchemaProperty[]
  additionalProperties?: boolean | "unknown"
  required?: string[]
}

export interface WebMcpToolSurface {
  kind: WebMcpDefinitionKind
  name: string | null
  title: string | null
  description: string | null
  inputSchema: NormalizedSchemaSummary
  annotations: {
    readOnlyHint: boolean | null
    untrustedContentHint: boolean | null
  }
  exposedTo: string[] | "dynamic" | null
  behavior: WebMcpBehavior
  networkMethods: string[]
  returnsExternalContent: boolean | null
  forwardsCancellation: boolean | null
  hasRegistrationCleanup: boolean | null
  runtimeValidation: WebMcpRuntimeValidation
  source: { path: string; startLine: number; endLine: number }
  definitionHash: string
}

export interface WebMcpToolInventory {
  version: string
  detectorVersion: string
  definitions: WebMcpToolSurface[]
  checksum: string
  incompleteDefinitions: number
  limitsReached: WebMcpScanLimit[]
  unsupportedFiles: string[]
  truncatedFiles: string[]
  notes: string[]
}

export interface WebMcpEvidenceLocation {
  path: string
  startLine: number
  endLine: number
  contentHash: string
}

export interface WebMcpCoverageReceipt {
  version: "webmcp-assurance/1"
  detectorVersion: string
  /** Legacy receipts omit this field and must be interpreted as INCONCLUSIVE. */
  coverageState?: "COMPLETE" | "INCONCLUSIVE"
  eligibleFiles: number
  scannedFiles: number
  scannedBytes: number
  toolDefinitionsFound: number
  toolDefinitionsAssessed: number
  incompleteDefinitions: number
  imperativeDefinitions: number
  declarativeDefinitions: number
  limitsReached: WebMcpScanLimit[]
  inventoryChecksum: string
  /** Outer repository selection receipt. Missing on legacy receipts. */
  sourceSelection?: {
    eligibleFiles: number
    selectedFiles: number
    skippedFiles: number
    /** Bytes admitted by outer source selection. Older receipts omit this field. */
    scannedBytes?: number
    skippedByReason: {
      fileLimit: number
      totalByteLimit: number
      oversized: number
      unreadable: number
    }
    limits: {
      maxFiles: number
      maxFileBytes: number
      maxTotalBytes: number
      maxWalkEntries: number
      maxWalkDepth: number
    }
    limitsReached: WebMcpScanLimit[]
  }
}

export interface WebMcpSignal {
  controlId: WebMcpControlId
  ruleId: string
  state: WebMcpEvidenceState
  severity: WebMcpSeverity
  file?: string
  line?: number
  endLine?: number
  snippet?: string
  remediation: string
  evidenceSource: WebMcpEvidenceSource
  detectorVersion: string
  evidenceChecksum: string
}

export interface WebMcpControlDefinition {
  id: WebMcpControlId
  title: string
  description: string
  strategy: "deterministic" | "advisory"
  severity: WebMcpSeverity
  negativeEvidence: string
  falsePositiveNotes: string
  remediationTemplate: string
}

export interface WebMcpControlCoverage {
  controlId: WebMcpControlId
  state: WebMcpEvidenceState
  assessed: boolean
  ruleIds: string[]
  fileCount: number
  signalCount: number
}

export interface WebMcpCoverageSummary {
  version: string
  totalControls: number
  assessedCount: number
  notAssessedCount: number
  detectedCount: number
  noFindingCount: number
  inconclusiveCount: number
  controls: Record<WebMcpControlId, WebMcpControlCoverage>
  limitsReached: WebMcpScanLimit[]
  unsupportedFiles: string[]
  truncatedFiles: string[]
}

export interface WebMcpScanResult {
  signals: WebMcpSignal[]
  coverage: WebMcpCoverageSummary
  inventory: WebMcpToolInventory
}

export interface WebMcpDiscoveryOptions {
  limits?: {
    maxFiles?: number
    maxFileBytes?: number
    maxTotalBytes?: number
    maxWallTimeMs?: number
    maxDefinitions?: number
    maxWalkEntries?: number
    maxWalkDepth?: number
  }
  signal?: AbortSignal
}

export interface ImperativeDiscoveryResult {
  tools: WebMcpToolSurface[]
  incomplete: number
  limitReached: boolean
}

export interface DeclarativeDiscoveryResult {
  tools: WebMcpToolSurface[]
  incomplete: number
  hasToolIframe: boolean
  limitsReached: WebMcpScanLimit[]
}

export interface WebMcpTextEdit {
  path?: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  newText: string
  controlIds: WebMcpControlId[]
}

export interface WebMcpRewritePlan {
  edits: WebMcpTextEdit[]
  addressed: WebMcpControlId[]
  unresolved: WebMcpControlId[]
  warnings: string[]
  updatedChecksum?: string
}

export interface WebMcpEvaluateContext {
  /** Optional repository header/config exposure metadata discovered by the config adapter. */
  headerExposure?: {
    hasOriginAgentCluster?: boolean | null
    hasToolsSelfPolicy?: boolean | null
    hasWildcardToolsPolicy?: boolean | null
    hasDocumentDomain?: boolean | null
    hasDelegatedToolsIframe?: boolean | null
    evidence?: {
      originAgentClusterDisabled?: WebMcpEvidenceLocation[]
      unsafeToolsPolicy?: WebMcpEvidenceLocation[]
      documentDomain?: WebMcpEvidenceLocation[]
      delegatedToolsIframe?: WebMcpEvidenceLocation[]
    }
  }
}
